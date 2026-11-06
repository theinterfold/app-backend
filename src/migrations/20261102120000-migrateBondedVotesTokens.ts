import { Models } from '@dbModels'
import RabbitMQHelper from '@helpers/rabbitMQ'
import TokenDetector from '@helpers/tokenDetector'
import logger from '@logger'
import type Token from '@models/schema/token'
import { EnumQueueName, type IMigration, IPluginStatus, ITokenType } from '@types'

const MIGRATION = '20261102120000-migrateBondedVotesTokens'
const llo = logger.logMeta.bind(null, { service: `Migration: ${MIGRATION}` })

/**
 * BondedVotes also exposes escrow() and clock(), so it was detected as an escrow adapter and the escrow behind it
 * indexed as the voting power source. That missed the bonded weight: the members of a BondedVotes token come from
 * its own events.
 */
export const findBondedVotesTokens = async (): Promise<Token[]> => {
  const candidates: Token[] = await Models.Token.find({ type: ITokenType.escrowAdapter })

  const tokens: Token[] = []
  for (const token of candidates) {
    try {
      const { type } = await TokenDetector.detectTokenType(token.address, token.network)
      if (type === ITokenType.bondedVotes) tokens.push(token)
    } catch (error) {
      logger.error(
        'Cannot detect token type, skipping',
        llo({ migration: MIGRATION, tokenAddress: token.address, error }),
      )
    }
  }

  return tokens
}

export const migrateBondedVotesToken = async (token: Token): Promise<void> => {
  const { address, network } = token

  await Models.Token.updateOne({ id: token.id }, { type: ITokenType.bondedVotes })
  // absent votingEscrow is null on a plugin and unset on a setting, as the schemas default it
  await Models.Plugin.updateMany({ tokenAddress: address, network }, { votingEscrow: null })
  await Models.Setting.updateMany({ tokenAddress: address, network }, { $unset: { votingEscrow: 1 } })
  await Models.Lock.deleteMany({ tokenAddress: address, network })

  // the plugin sync crawls the token from its first block under the new token type
  const plugins = await Models.Plugin.find({ tokenAddress: address, network, status: IPluginStatus.installed })
  for (const plugin of plugins) {
    await RabbitMQHelper.sendMessage(EnumQueueName.plugins, {
      id: `${network}-${plugin.address}`,
      params: { address: plugin.address, network },
    })
  }
}

export const migrateBondedVotesTokensMigration: IMigration = {
  start: async () => {
    logger.info('Starting migration', llo({ migration: MIGRATION }))

    try {
      const tokens = await findBondedVotesTokens()

      let migrated = 0
      for (const token of tokens) {
        try {
          await migrateBondedVotesToken(token)
          migrated++
          logger.verbose(
            'Migrated BondedVotes token',
            llo({ migration: MIGRATION, tokenAddress: token.address, network: token.network }),
          )
        } catch (error) {
          logger.error(
            'Cannot migrate BondedVotes token, skipping',
            llo({ migration: MIGRATION, tokenAddress: token.address, network: token.network, error }),
          )
        }
      }

      logger.info(
        'Migration completed successfully',
        llo({ migration: MIGRATION, migrated, skipped: tokens.length - migrated }),
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

export default migrateBondedVotesTokensMigration
