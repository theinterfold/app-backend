import { Models } from '@dbModels'
import { CrispInterfoldHandler } from '@handlers/crispInterfoldHandler'
import RabbitMQHelper from '@helpers/rabbitMQ'
import logger from '@logger'
import type Plugin from '@models/schema/plugin'
import type Proposal from '@models/schema/proposal'
import { EnumQueueName, type IMigration, IPluginInterfaceType } from '@types'

const MIGRATION = '20261105120000-backfillCrispProposals'
const llo = logger.logMeta.bind(null, { service: `Migration: ${MIGRATION}` })

// CRISP proposals indexed before the indexer read the round of a proposal have none of it: give them what
// ProposalCreated stores now, and the final tally of those already executed. The tally of the others comes with the
// Interfold crawl queued afterwards. A proposal is selected by its missing e3Id, so a re-run resumes where it stopped.
export const backfillCrispProposal = async (proposal: Proposal, plugin: Plugin): Promise<boolean> => {
  const { network, proposalIndex } = proposal
  const data = await CrispInterfoldHandler.readProposalData(plugin, proposalIndex, network)
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
}

export const backfillCrispProposalsMigration: IMigration = {
  start: async () => {
    logger.info('Starting migration', llo({ migration: MIGRATION }))

    try {
      const plugins: Plugin[] = await Models.Plugin.find({ interfaceType: IPluginInterfaceType.crisp })

      let backfilled = 0
      let skipped = 0
      for (const plugin of plugins) {
        const { address: pluginAddress, network } = plugin
        try {
          await CrispInterfoldHandler.ensureInterfold(plugin)
        } catch (error) {
          logger.error(
            'Cannot read the Interfold of the plugin',
            llo({ migration: MIGRATION, pluginAddress, network, error }),
          )
        }

        const proposals: Proposal[] = await Models.Proposal.find({ pluginAddress, network, e3Id: { $exists: false } })
        for (const proposal of proposals) {
          try {
            if (await backfillCrispProposal(proposal, plugin)) backfilled++
            else skipped++
          } catch (error) {
            skipped++
            logger.error(
              'Cannot backfill CRISP proposal, skipping',
              llo({ migration: MIGRATION, pluginAddress, network, proposalIndex: proposal.proposalIndex, error }),
            )
          }
        }
      }

      for (const network of new Set(plugins.map(plugin => plugin.network))) {
        await RabbitMQHelper.sendMessage(EnumQueueName.logInterfold, { id: network, params: { network } })
      }

      logger.info('Migration completed successfully', llo({ migration: MIGRATION, backfilled, skipped }))
    } catch (error) {
      logger.error('Migration failed', llo({ migration: MIGRATION, error }))
      throw error
    }
  },

  stop: async () => {
    // Usually empty for migrations
  },
}

export default backfillCrispProposalsMigration
