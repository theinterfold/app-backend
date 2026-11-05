import { Models } from '@dbModels'
import { GovernanceErc20Handler } from '@handlers/governanceErc20Handler'
import GovernanceBondedVotesHelper from '@helpers/governanceBondedVotes'
import utils from '@helpers/utils'
import Web3Utils from '@helpers/web3Utils'
import logger from '@logger'
import { Erc20Governance } from '@src/governance/erc20Governance'
import { type HexAddress, type ILogInfo, IPluginStatus, ITokenType, type NetworksEnum } from '@types'
import { type LogDescription } from 'ethers'

const llo = logger.logMeta.bind(null, { service: 'handlers:GovernanceBondedVotesHandler' })

type IEvent = { parsedEvent: LogDescription; info: ILogInfo }

// BondedVotes emits no DelegateVotesChanged: its voting power moves with bonds, bonded delegation and the votes source
// it wraps (an ERC20Votes token, or an escrow adapter and its escrow). Events name the affected accounts; the new
// power is read from the contract.
//
// Known gap: with an escrow votes source, the power also includes FOLD vesting locks, and changes to those emit no
// event any crawler watches. Holders whose power comes only from vesting may be missing from the member list, or stale.
const affectedAccounts = ({ parsedEvent: { name, args } }: IEvent): string[] => {
  switch (name) {
    case 'BondedDelegateChanged':
      return [args.owner, args.fromDelegate, args.toDelegate]
    case 'BondedCheckpointed':
      return [args.bondOwner]
    case 'DelegateVotesChanged':
      return [args.delegate]
    case 'DelegateChanged':
      return [args.delegator, args.fromDelegate, args.toDelegate]
    case 'Deposit':
    case 'Withdraw':
      return [args.depositor]
    default:
      return []
  }
}

// Installed, supported BondedVotes tokens that read voting power from the contract emitting the event. Anyone can
// deploy a token that reports another token's sources, so only tokens a DAO runs a plugin on are considered, and a
// token whose sources cannot be read is skipped instead of failing the batch.
const findTokens = async (emitter: string, network: NetworksEnum): Promise<HexAddress[]> => {
  const candidates = await Models.Token.find({ network, type: ITokenType.bondedVotes })
  const used = new Set(
    await Models.Plugin.distinct('tokenAddress', {
      network,
      tokenAddress: { $in: candidates.map(token => token.address) },
      status: IPluginStatus.installed,
      isSupported: true,
    }),
  )

  const matches = await Promise.all(
    candidates
      .filter(token => used.has(token.address))
      .map(async token => {
        try {
          const { checkpoints, votesSource, escrow } = await GovernanceBondedVotesHelper.getSources(
            token.address,
            network,
          )
          const feeds = [token.address, checkpoints, votesSource, escrow].some(
            address => address?.toLowerCase() === emitter.toLowerCase(),
          )
          return feeds ? token.address : null
        } catch (error) {
          logger.warn(
            'Cannot read the sources of a BondedVotes token, skipping it',
            llo({ token: token.address, error }),
          )
          return null
        }
      }),
  )

  return matches.filter((address): address is HexAddress => !!address)
}

const refreshToken = async (token: HexAddress, network: NetworksEnum, events: IEvent[]) => {
  const governance = new Erc20Governance(token, network)
  const plugins = await governance.getPlugins()
  if (plugins.length === 0) return

  // account -> latest block that touched it
  const touch = (accounts: Map<HexAddress, number>, address: string, blockNumber: number) => {
    const account = Web3Utils.parseAddress(address as HexAddress)
    if (!account || account === utils.zeroAddress) return
    accounts.set(account, Math.max(accounts.get(account) ?? 0, blockNumber))
  }

  const accounts = new Map<HexAddress, number>()
  const bondOwners = new Map<HexAddress, number>()
  for (const { parsedEvent, info } of events) {
    affectedAccounts({ parsedEvent, info }).forEach(address => touch(accounts, address, info.blockNumber))
    if (parsedEvent.name === 'BondedCheckpointed') touch(bondOwners, parsedEvent.args.bondOwner, info.blockNumber)
  }

  // an owner's bond counts at its bonded delegate while it delegates
  const owners = [...bondOwners]
  const delegates = await Promise.all(
    owners.map(async ([owner]) => GovernanceBondedVotesHelper.getBondedDelegate(token, network, owner)),
  )
  owners.forEach(([, blockNumber], i) => touch(accounts, delegates[i], blockNumber))

  const entries = [...accounts]
  const votes = await Promise.all(
    entries.map(([account]) => GovernanceBondedVotesHelper.getVotes(token, network, account)),
  )
  const updates = entries.map(([memberAddress, lastVPBlockNumber], i) => ({
    memberAddress,
    votingPower: votes[i].toString(),
    lastVPBlockNumber,
  }))

  await Erc20Governance.createMembersBatchNoTx(
    updates.map(({ memberAddress, lastVPBlockNumber }) => ({ memberAddress, lastActivity: lastVPBlockNumber })),
  )
  await governance.updateTokenMemberVPBatchNoTx(updates)
  await governance.updatePluginMetricsBatchNoTx(
    plugins.flatMap(plugin =>
      updates.map(({ memberAddress, lastVPBlockNumber }) => ({
        memberAddress,
        pluginAddress: plugin.address,
        daoAddress: plugin.daoAddress,
        lastActivity: lastVPBlockNumber,
      })),
    ),
  )
  await governance.updateDaoMetrics()
}

// Resolves the tokens the emitter feeds, for events that do not come from a crawl bound to one token. A failing token
// is logged and skipped, so it cannot block the others.
const refreshByEmitter = async (events: IEvent[]) => {
  const byEmitter = new Map<string, IEvent[]>()
  for (const event of events) {
    const key = `${event.info.network}-${event.info.address}`
    byEmitter.set(key, [...(byEmitter.get(key) ?? []), event])
  }

  for (const group of byEmitter.values()) {
    const { address, network } = group[0].info
    const tokens = await findTokens(address, network)
    const results = await Promise.allSettled(tokens.map(async token => refreshToken(token, network, group)))
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        logger.error('VotingPowerChanged - error', llo({ error: result.reason, token: tokens[i], emitter: address }))
      }
    })
  }
}

const createHandlers = (refresh: (events: IEvent[]) => Promise<void>) => {
  const votingPowerChangedBatch = async (events: IEvent[]) => {
    try {
      await refresh(events)
    } catch (error) {
      logger.error('VotingPowerChanged - error', llo({ error, eventCount: events.length }))
      throw error
    }
  }

  const bondedDelegateChangedBatch = async (events: IEvent[]) => {
    // reshaped as an ERC20 DelegateChanged log so delegations are served as for ERC20 tokens
    await GovernanceErc20Handler.delegateChangedBatch(
      events.map(({ parsedEvent, info }) => ({
        info,
        parsedEvent: {
          args: {
            delegator: parsedEvent.args.owner,
            fromDelegate: parsedEvent.args.fromDelegate,
            toDelegate: parsedEvent.args.toDelegate,
          },
        } as unknown as LogDescription,
      })),
    )
    await votingPowerChangedBatch(events)
  }

  return {
    // Re-reads the voting power of every account the events touch.
    votingPowerChangedBatch,
    votingPowerChanged: async (parsedEvent: LogDescription, info: ILogInfo) =>
      votingPowerChangedBatch([{ parsedEvent, info }]),
    bondedDelegateChangedBatch,
    bondedDelegateChanged: async (parsedEvent: LogDescription, info: ILogInfo) =>
      bondedDelegateChangedBatch([{ parsedEvent, info }]),
  }
}

export const GovernanceBondedVotesHandler = {
  // For every installed BondedVotes token the emitting contract feeds.
  ...createHandlers(refreshByEmitter),

  // Handlers for the crawl of one token: its events are never matched against other tokens' sources.
  forToken: (token: HexAddress) =>
    createHandlers(async events => {
      if (events.length > 0) await refreshToken(token, events[0].info.network, events)
    }),
}
