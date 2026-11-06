import { Models } from '@dbModels'
import ConfigIndexerHelper from '@helpers/configIndexer'
import RabbitMQHelper from '@helpers/rabbitMQ'
import logger from '@logger'
import type Token from '@models/schema/token'
import { EnumQueueName, type IMigration, IPluginStatus, ITokenType } from '@types'

const MIGRATION = '20261104120000-reindexBondedVotesMembers'
const llo = logger.logMeta.bind(null, { service: `Migration: ${MIGRATION}` })

/**
 * The votes source a BondedVotes token wraps, and the escrow behind it, are deployed before the token and hold the
 * delegations and locks, so a crawl starting at the token's block (or the plugin's) never made their holders
 * members. The crawl starts at the first block of every contract it reads: drop its progress and sync the plugins
 * again from there.
 */
export const reindexBondedVotesToken = async (token: Token): Promise<void> => {
  const { address, network } = token

  await Models.ConfigIndexer.deleteOne({
    network,
    service: ConfigIndexerHelper.builders.token(ITokenType.bondedVotes, network, address),
  })

  const plugins = await Models.Plugin.find({ tokenAddress: address, network, status: IPluginStatus.installed })
  for (const plugin of plugins) {
    await RabbitMQHelper.sendMessage(EnumQueueName.plugins, {
      id: `${network}-${plugin.address}`,
      params: { address: plugin.address, network },
    })
  }
}

export const reindexBondedVotesMembersMigration: IMigration = {
  start: async () => {
    logger.info('Starting migration', llo({ migration: MIGRATION }))

    try {
      const tokens: Token[] = await Models.Token.find({ type: ITokenType.bondedVotes })

      let reindexed = 0
      for (const token of tokens) {
        try {
          await reindexBondedVotesToken(token)
          reindexed++
          logger.verbose(
            'Reindexed BondedVotes token',
            llo({ migration: MIGRATION, tokenAddress: token.address, network: token.network }),
          )
        } catch (error) {
          logger.error(
            'Cannot reindex BondedVotes token, skipping',
            llo({ migration: MIGRATION, tokenAddress: token.address, network: token.network, error }),
          )
        }
      }

      logger.info(
        'Migration completed successfully',
        llo({ migration: MIGRATION, reindexed, skipped: tokens.length - reindexed }),
      )
    } catch (error) {
      logger.error('Migration failed', llo({ migration: MIGRATION, error }))
      throw error
    }
  },

  stop: async () => {
    // Usually empty for migrations
  },
}

export default reindexBondedVotesMembersMigration
