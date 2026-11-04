import { Models } from '@dbModels'
import { GovernanceErc20Handler } from '@handlers/governanceErc20Handler'
import GovernanceBondedVotesHelper from '@helpers/governanceBondedVotes'
import utils from '@helpers/utils'
import Web3Utils from '@helpers/web3Utils'
import logger from '@logger'
import { Erc20Governance } from '@src/governance/erc20Governance'
import { type HexAddress, type ILogInfo, ITokenType, type NetworksEnum } from '@types'
import { type LogDescription } from 'ethers'

const llo = logger.logMeta.bind(null, { service: 'handlers:GovernanceBondedVotesHandler' })

type IEvent = { parsedEvent: LogDescription; info: ILogInfo }

// BondedVotes emits no DelegateVotesChanged: its voting power moves with bonds and bonded
// delegation, plus the votes source it wraps (an ERC20Votes token, or an escrow adapter and the
// escrow behind it).
// Events name the accounts that changed; the new power is read from the contract.
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

// BondedVotes tokens that read voting power from the contract emitting the event.
const findTokens = async (emitter: string, network: NetworksEnum): Promise<HexAddress[]> => {
  const tokens = await Models.Token.find({ network, type: ITokenType.bondedVotes })
  const sources = await Promise.all(tokens.map(token => GovernanceBondedVotesHelper.getSources(token.address, network)))

  return tokens
    .filter((token, i) =>
      [token.address, sources[i].checkpoints, sources[i].votesSource, sources[i].escrow].some(
        address => address?.toLowerCase() === emitter.toLowerCase(),
      ),
    )
    .map(token => token.address)
}

const refreshToken = async (token: HexAddress, network: NetworksEnum, events: IEvent[]) => {
  const governance = new Erc20Governance(token, network)
  const plugins = await governance.getPlugins()
  if (plugins.length === 0) return

  // account -> latest block that touched it
  const accounts = new Map<HexAddress, number>()
  const touch = (address: string, blockNumber: number) => {
    const account = Web3Utils.parseAddress(address as HexAddress)
    if (!account || account === utils.zeroAddress) return
    accounts.set(account, Math.max(accounts.get(account) ?? 0, blockNumber))
  }

  for (const event of events) {
    const { blockNumber } = event.info
    affectedAccounts(event).forEach(address => touch(address, blockNumber))

    // an owner's bond counts at its bonded delegate while it delegates
    if (event.parsedEvent.name === 'BondedCheckpointed') {
      const delegate = await GovernanceBondedVotesHelper.getBondedDelegate(
        token,
        network,
        event.parsedEvent.args.bondOwner,
      )
      touch(delegate, blockNumber)
    }
  }

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

export const GovernanceBondedVotesHandler = {
  // Re-reads the voting power of every account the events touch, for each BondedVotes token the
  // emitting contract feeds.
  votingPowerChangedBatch: async (events: IEvent[]) => {
    try {
      const byEmitter = new Map<string, IEvent[]>()
      for (const event of events) {
        const key = `${event.info.network}-${event.info.address}`
        byEmitter.set(key, [...(byEmitter.get(key) ?? []), event])
      }

      for (const group of byEmitter.values()) {
        const { address, network } = group[0].info
        for (const token of await findTokens(address, network)) {
          await refreshToken(token, network, group)
        }
      }
    } catch (error) {
      logger.error('VotingPowerChanged - error', llo({ error, eventCount: events.length }))
      throw error
    }
  },

  votingPowerChanged: async (parsedEvent: LogDescription, info: ILogInfo) =>
    GovernanceBondedVotesHandler.votingPowerChangedBatch([{ parsedEvent, info }]),

  bondedDelegateChangedBatch: async (events: IEvent[]) => {
    // same shape as the ERC20 DelegateChanged log, so delegators and delegations are served as for ERC20 tokens
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
    await GovernanceBondedVotesHandler.votingPowerChangedBatch(events)
  },

  bondedDelegateChanged: async (parsedEvent: LogDescription, info: ILogInfo) =>
    GovernanceBondedVotesHandler.bondedDelegateChangedBatch([{ parsedEvent, info }]),
}
