import { Models } from '@dbModels'
import { CrispInterfoldHandler } from '@handlers/crispInterfoldHandler'
import RabbitMQHelper from '@helpers/rabbitMQ'
import logger from '@logger'
import type Plugin from '@models/schema/plugin'
import type Proposal from '@models/schema/proposal'
import { EnumQueueName, type IMigration, IPluginInterfaceType } from '@types'

const MIGRATION = '20261105120000-backfillCrispProposals'
const llo = logger.logMeta.bind(null, { service: `Migration: ${MIGRATION}` })

// Backfills the CRISP proposals indexed before the indexer read the round of a proposal. For every CRISP plugin it
// reads the plugin's Interfold, then gives each proposal still missing its e3Id what ProposalCreated stores for a
// CRISP proposal, and the final tally of those already executed (CrispInterfoldHandler.backfillProposal). A proposal
// that cannot be backfilled is logged and skipped, and a re-run resumes where it stopped. The tally of the other
// proposals comes with the Interfold events, from the crawl queued for every network with a CRISP plugin at the end,
// or with the round sweep when that crawl has already passed them.
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
            if (await CrispInterfoldHandler.backfillProposal(proposal, plugin)) backfilled++
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
