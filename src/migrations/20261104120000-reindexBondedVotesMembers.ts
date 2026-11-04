import { Models } from '@dbModels'
import ConfigIndexerHelper from '@helpers/configIndexer'
import RabbitMQHelper from '@helpers/rabbitMQ'
import logger from '@logger'
import type Token from '@models/schema/token'
import { EnumQueueName, type IMigration, IPluginStatus, ITokenType } from '@types'

const MIGRATION = '20261104120000-reindexBondedVotesMembers'
const llo = logger.logMeta.bind(null, { service: `Migration: ${MIGRATION}` })

/**
 * The BondedVotes crawl used to start at the token's block, or the plugin's when that is unknown. The
 * votes source it wraps, and the escrow behind it, are deployed earlier and hold the delegations and
 * locks, so their holders never became members. The crawl now starts at the first block of every contract
 * it reads: drop its progress and sync the plugins again from there.
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

      for (const token of tokens) {
        await reindexBondedVotesToken(token)
        logger.verbose(
          'Reindexed BondedVotes token',
          llo({ migration: MIGRATION, tokenAddress: token.address, network: token.network }),
        )
      }

      logger.info('Migration completed successfully', llo({ migration: MIGRATION, reindexed: tokens.length }))
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
