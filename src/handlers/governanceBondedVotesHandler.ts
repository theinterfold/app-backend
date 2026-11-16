import { GovernanceERC20 } from '@artifacts/GovernanceERC20'
import { VotingEscrow } from '@artifacts/VotingEscrow'
import { VotingEscrowIncreasing } from '@artifacts/VotingEscrowIncreasing'
import { Models } from '@dbModels'
import { GovernanceErc20Handler } from '@handlers/governanceErc20Handler'
import GovernanceBondedVotesHelper from '@helpers/governanceBondedVotes'
import utils from '@helpers/utils'
import Web3Utils from '@helpers/web3Utils'
import logger from '@logger'
import { Erc20Governance } from '@src/governance/erc20Governance'
import { type HexAddress, type ILogInfo, IPluginStatus, ITokenType, type NetworksEnum } from '@types'
import { ethers, Interface, type Log, type LogDescription } from 'ethers'

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
    // The escrow adapter moves the delegatee's power when a lock is created, transferred, withdrawn, split or
    // merged, and on explicit (un)delegation of lock ids, and emits only these for it, not DelegateChanged.
    case 'TokensDelegated':
    case 'TokensUndelegated':
      return [args.sender, args.delegatee]
    default:
      return []
  }
}

// Events of the contracts a BondedVotes token reads its voting power from, as the live crawler sees them. The token
// and its checkpoints emit BondedDelegateChanged and BondedCheckpointed, which have their own crawler config.
const sourceTopics = new Map<string, { eventName: string; iface: Interface }>()
const registerSourceTopics = (eventNames: string[], iface: Interface) => {
  for (const eventName of eventNames) {
    const topic = iface.getEvent(eventName)?.topicHash
    if (topic) sourceTopics.set(topic, { eventName, iface })
  }
}
registerSourceTopics(['DelegateVotesChanged'], new Interface(GovernanceERC20.abi))
registerSourceTopics(['DelegateChanged', 'TokensDelegated', 'TokensUndelegated'], new Interface(VotingEscrow.abi))
registerSourceTopics(['Deposit', 'Withdraw'], new Interface(VotingEscrowIncreasing.abi))

export const BONDED_VOTES_SOURCE_TOPICS = new Set(sourceTopics.keys())

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
    const group = byEmitter.get(key)
    if (group) group.push(event)
    else byEmitter.set(key, [event])
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

const handlers = createHandlers(refreshByEmitter)

export const GovernanceBondedVotesHandler = {
  // For every installed BondedVotes token the emitting contract feeds.
  ...handlers,

  // Live logs of the contracts feeding BondedVotes tokens (see BONDED_VOTES_SOURCE_TOPICS), already matched to their
  // emitters by the caller. Returns the number of events handled.
  processSourceLogs: async (logs: Log[], network: NetworksEnum): Promise<number> => {
    const events: IEvent[] = []
    for (const log of logs) {
      const topicInfo = sourceTopics.get(log.topics[0])
      if (!topicInfo) continue
      try {
        const parsedEvent = topicInfo.iface.parseLog({ topics: log.topics as string[], data: log.data })
        if (!parsedEvent) continue
        events.push({
          parsedEvent,
          info: {
            network,
            blockNumber: log.blockNumber,
            transactionIndex: log.transactionIndex,
            logIndex: log.index,
            transactionHash: log.transactionHash as HexAddress,
            address: ethers.getAddress(log.address) as HexAddress,
            eventName: topicInfo.eventName,
          },
        })
      } catch (error) {
        logger.warn('Cannot parse a BondedVotes source log, skipping it', llo({ network, error, log }))
      }
    }

    if (events.length > 0) await handlers.votingPowerChangedBatch(events)
    return events.length
  },

  // Handlers for the crawl of one token: its events are never matched against other tokens' sources.
  forToken: (token: HexAddress) =>
    createHandlers(async events => {
      if (events.length > 0) await refreshToken(token, events[0].info.network, events)
    }),
}
