import { Models } from '@dbModels'
import CrispHelper from '@helpers/crisp'
import ProposalHelper from '@helpers/proposal'
import logger from '@logger'
import type Plugin from '@models/schema/plugin'
import type Proposal from '@models/schema/proposal'
import { type HexAddress, type ILogInfo, IPluginInterfaceType, type NetworksEnum } from '@types'
import { getAddress, type LogDescription } from 'ethers'

const llo = logger.logMeta.bind(null, { service: 'handlers:CrispInterfoldHandler' })

type IEvent = { parsedEvent: LogDescription; info: ILogInfo }

// Token voting vote option (ABSTAIN = 1, YES = 2, NO = 3) of each CRISP tally index, which orders its options
// YES, NO, ABSTAIN
const CRISP_VOTE_OPTIONS = [2, 3, 1]

const buildVotesByOption = (counts: bigint[], divisor: string) =>
  counts.flatMap((count, index) =>
    CRISP_VOTE_OPTIONS[index] === undefined
      ? []
      : [{ type: CRISP_VOTE_OPTIONS[index], totalVotingPower: (count * BigInt(divisor)).toString() }],
  )

const hasDivisor = (divisor: string | undefined): divisor is string => !!divisor && BigInt(divisor) > 0n

// Runs a read and never throws: a failed read is logged and leaves its field unset
const settle = async <T>(what: string, context: object, read: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await read()
  } catch (error) {
    logger.error(`CrispInterfoldHandler - cannot read ${what}`, llo({ ...context, error }))
    return undefined
  }
}

// Applies each Interfold event to the CRISP proposal of its e3Id. The event is trusted only when its emitter is the
// coordinator the proposal's plugin stored: e3Ids are only unique per coordinator, and anyone can deploy one.
// A failure is logged and skips that event, it never stops the others.
const forEachProposal = async (
  events: IEvent[],
  apply: (proposal: Proposal, plugin: Plugin, event: IEvent) => Promise<void>,
) => {
  const pluginsByEmitter = new Map<string, Plugin[]>()

  for (const event of events) {
    const { network, address } = event.info
    try {
      const emitter = getAddress(address)
      const key = `${network}-${emitter}`
      if (!pluginsByEmitter.has(key)) {
        pluginsByEmitter.set(
          key,
          await Models.Plugin.find({ network, interfaceType: IPluginInterfaceType.crisp, interfoldAddress: emitter }),
        )
      }
      const plugins = pluginsByEmitter.get(key)!
      if (plugins.length === 0) continue

      const proposal = await Models.Proposal.findOne({
        network,
        e3Id: event.parsedEvent.args.e3Id.toString(),
        pluginAddress: { $in: plugins.map(plugin => plugin.address) },
      })
      if (!proposal) continue

      await apply(proposal, plugins.find(plugin => plugin.address === proposal.pluginAddress)!, event)
    } catch (error) {
      logger.error(
        'CrispInterfoldHandler - error',
        llo({
          network,
          emitter: address,
          event: event.parsedEvent.name,
          transactionHash: event.info.transactionHash,
          error,
        }),
      )
    }
  }
}

export const CrispInterfoldHandler = {
  // Reads and stores the plugin's Interfold coordinator when it is not stored yet
  ensureInterfold: async (plugin: Plugin): Promise<HexAddress> => {
    if (plugin.interfoldAddress) return plugin.interfoldAddress

    const interfoldAddress = await CrispHelper.getInterfold(plugin.address, plugin.network)
    await Models.Plugin.updateOne({ _id: plugin._id }, { $set: { interfoldAddress } })
    plugin.interfoldAddress = interfoldAddress
    return interfoldAddress
  },

  // What a CRISP proposal carries from the contract. Frozen at creation, so it is read once; the tally is filled in
  // when the round publishes it. Returns null when the contract has no such proposal. With a `blockNumber` the
  // proposal is read at that block.
  readProposalData: async (plugin: Plugin, proposalIndex: string, network: NetworksEnum, blockNumber?: number) => {
    const context = { pluginAddress: plugin.address, proposalIndex, network }
    const onChain = await ProposalHelper.getProposalCrisp({
      proposalIndex,
      pluginAddress: plugin.address,
      network,
      blockNumber,
    })

    // a proposal this plugin never created reads back as zeroes
    if (!onChain || Number(onChain.parameters.snapshotBlock) === 0) return null

    const e3Id = onChain.e3Id.toString()
    const [historicalTotalSupply, interfold] = await Promise.all([
      settle('the total voting power', context, async () =>
        CrispHelper.getTotalVotingPower(plugin.address, network, onChain.parameters.snapshotBlock),
      ),
      settle('the Interfold coordinator', context, async () => CrispInterfoldHandler.ensureInterfold(plugin)),
    ])
    const divisorRead = interfold
      ? await settle('the voting power divisor', { ...context, e3Id }, async () =>
          CrispHelper.getVotingPowerDivisor(interfold, e3Id, network),
        )
      : undefined

    return {
      e3Id,
      historicalTotalSupply,
      // a zero divisor means the round has none: left unset, like one that could not be read
      votingPowerDivisor: hasDivisor(divisorRead) ? divisorRead : undefined,
      settings: {
        minParticipation: Number(onChain.parameters.minParticipation),
        supportThreshold: Number(onChain.parameters.supportThreshold),
        minVoterVotingPower: onChain.parameters.minVotingPower.toString(),
      },
    }
  },

  // Gives a CRISP proposal stored without its round what ProposalCreated stores for one, and the final tally when it
  // is already executed. The tally of the others comes with the Interfold events or the round sweep. Returns false
  // when the proposal cannot be read from the contract; it is then still selected by its missing e3Id the next time.
  backfillProposal: async (proposal: Proposal, plugin: Plugin): Promise<boolean> => {
    const data = await CrispInterfoldHandler.readProposalData(plugin, proposal.proposalIndex, proposal.network)
    if (!data) return false

    const updated = await Models.Proposal.findOneAndUpdate(
      { _id: proposal._id },
      {
        $set: {
          e3Id: data.e3Id,
          isTallyPublished: false,
          ...(data.votingPowerDivisor && { votingPowerDivisor: data.votingPowerDivisor }),
          ...(data.historicalTotalSupply !== undefined && { 'snapshot.totalSupply': data.historicalTotalSupply }),
          'settings.minParticipation': data.settings.minParticipation,
          'settings.supportThreshold': data.settings.supportThreshold,
          'settings.minVoterVotingPower': data.settings.minVoterVotingPower,
        },
      },
      { returnDocument: 'after' },
    )
    if (updated?.executed?.status) await CrispInterfoldHandler.syncTally(updated, plugin)

    return true
  },

  // Stores the tally the plugin reports, in raw token units, and marks it published. Called when the round publishes
  // its plaintext output and again at execution, when the stored tally is final. A failed read is logged and nothing
  // is stored, so the tally stays unpublished and the sweep retries; only the final write can throw.
  syncTally: async (proposal: Proposal, plugin: Plugin) => {
    const { network, proposalIndex, e3Id } = proposal
    const context = { pluginAddress: plugin.address, proposalIndex, network }

    const counts = await settle('the tally', context, async () =>
      CrispHelper.getTally(plugin.address, network, proposalIndex),
    )
    if (!counts) return

    // a zero divisor means the round has none, as `CrispVoting._canExecute` reads it: nothing to scale the counts with
    let divisor = hasDivisor(proposal.votingPowerDivisor) ? proposal.votingPowerDivisor : undefined
    if (!divisor && e3Id && plugin.interfoldAddress) {
      const interfold = plugin.interfoldAddress
      const read = await settle('the voting power divisor', { ...context, e3Id }, async () =>
        CrispHelper.getVotingPowerDivisor(interfold, e3Id, network),
      )
      divisor = hasDivisor(read) ? read : undefined
    }

    if (!divisor) {
      logger.warn(
        'CrispInterfoldHandler - the round has no voting power divisor, the tally stays unpublished',
        llo({ ...context, e3Id }),
      )
      return
    }

    await Models.Proposal.updateOne(
      { _id: proposal._id },
      {
        $set: {
          isTallyPublished: true,
          'metrics.votesByOption': buildVotesByOption(counts, divisor),
          votingPowerDivisor: divisor,
        },
      },
    )
  },

  plaintextOutputPublishedBatch: async (events: IEvent[]) =>
    forEachProposal(events, async (proposal, plugin) => {
      // once published the tally only changes at execution, which re-reads it
      if (proposal.isTallyPublished) return
      await CrispInterfoldHandler.syncTally(proposal, plugin)
    }),

  plaintextOutputPublished: async (parsedEvent: LogDescription, info: ILogInfo) =>
    CrispInterfoldHandler.plaintextOutputPublishedBatch([{ parsedEvent, info }]),

  e3FailedBatch: async (events: IEvent[]) =>
    forEachProposal(events, async (proposal, _plugin, { parsedEvent }) => {
      await Models.Proposal.updateOne(
        { _id: proposal._id },
        { $set: { failureReason: Number(parsedEvent.args.reason) } },
      )
    }),

  e3Failed: async (parsedEvent: LogDescription, info: ILogInfo) =>
    CrispInterfoldHandler.e3FailedBatch([{ parsedEvent, info }]),
}
