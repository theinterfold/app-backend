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
  ensureInterfold: async (plugin: Plugin): Promise<HexAddress | undefined> => {
    if (plugin.interfoldAddress) return plugin.interfoldAddress

    const interfoldAddress = await CrispHelper.getInterfold(plugin.address, plugin.network)
    await Models.Plugin.updateOne({ _id: plugin._id }, { $set: { interfoldAddress } })
    plugin.interfoldAddress = interfoldAddress
    return interfoldAddress
  },

  // What a CRISP proposal carries from the contract. Frozen at creation, so it is read once; the tally is filled in
  // when the round publishes it. Returns null when the contract has no such proposal.
  readProposalData: async (plugin: Plugin, proposalIndex: string, network: NetworksEnum) => {
    const context = { pluginAddress: plugin.address, proposalIndex, network }
    const onChain = await ProposalHelper.getProposalCrisp({ proposalIndex, pluginAddress: plugin.address, network })

    // a proposal this plugin never created reads back as zeroes
    if (!onChain || Number(onChain.parameters.snapshotBlock) === 0) return null

    const e3Id = onChain.e3Id.toString()
    const [historicalTotalSupply, interfold] = await Promise.all([
      settle('the total voting power', context, async () =>
        CrispHelper.getTotalVotingPower(plugin.address, network, onChain.parameters.snapshotBlock),
      ),
      settle('the Interfold coordinator', context, async () => CrispInterfoldHandler.ensureInterfold(plugin)),
    ])
    const votingPowerDivisor = interfold
      ? await settle('the voting power divisor', { ...context, e3Id }, async () =>
          CrispHelper.getVotingPowerDivisor(interfold, e3Id, network),
        )
      : undefined

    return {
      e3Id,
      historicalTotalSupply,
      votingPowerDivisor,
      settings: {
        minParticipation: Number(onChain.parameters.minParticipation),
        supportThreshold: Number(onChain.parameters.supportThreshold),
        minVoterVotingPower: onChain.parameters.minVotingPower.toString(),
      },
    }
  },

  // Stores the tally the plugin reports, in raw token units, and marks it published. Called when the round publishes
  // its plaintext output and again at execution, when the stored tally is final. Never throws.
  syncTally: async (proposal: Proposal, plugin: Plugin) => {
    const { network, proposalIndex, e3Id } = proposal
    const context = { pluginAddress: plugin.address, proposalIndex, network }

    const counts = await settle('the tally', context, async () =>
      CrispHelper.getTally(plugin.address, network, proposalIndex),
    )
    if (!counts) return

    let divisor = proposal.votingPowerDivisor
    if (!divisor && e3Id && plugin.interfoldAddress) {
      const interfold = plugin.interfoldAddress
      divisor = await settle('the voting power divisor', { ...context, e3Id }, async () =>
        CrispHelper.getVotingPowerDivisor(interfold, e3Id, network),
      )
    }

    await Models.Proposal.updateOne(
      { _id: proposal._id },
      {
        $set: {
          isTallyPublished: true,
          'metrics.votesByOption': divisor ? buildVotesByOption(counts, divisor) : [],
          ...(divisor && { votingPowerDivisor: divisor }),
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
