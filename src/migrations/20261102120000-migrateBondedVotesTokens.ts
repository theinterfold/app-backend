import { Models } from '@dbModels'
import RabbitMQHelper from '@helpers/rabbitMQ'
import TokenDetector from '@helpers/tokenDetector'
import logger from '@logger'
import type Token from '@models/schema/token'
import { EnumQueueName, type IMigration, IPluginStatus, ITokenType } from '@types'

const MIGRATION = '20261102120000-migrateBondedVotesTokens'
const llo = logger.logMeta.bind(null, { service: `Migration: ${MIGRATION}` })

/**
 * BondedVotes also exposes escrow() and clock(), so it used to be stored as an escrow adapter and the
 * escrow behind it indexed as the voting power source. BondedVotes adds bonded weight on top, which that
 * missed, and its members come from its own events now.
 */
export const findBondedVotesTokens = async (): Promise<Token[]> => {
  const candidates: Token[] = await Models.Token.find({ type: ITokenType.escrowAdapter })

  const tokens: Token[] = []
  for (const token of candidates) {
    const { type } = await TokenDetector.detectTokenType(token.address, token.network)
    if (type === ITokenType.bondedVotes) tokens.push(token)
  }

  return tokens
}

export const migrateBondedVotesToken = async (token: Token): Promise<void> => {
  const { address, network } = token

  await Models.Token.updateOne({ id: token.id }, { type: ITokenType.bondedVotes })
  await Models.Plugin.updateMany({ tokenAddress: address, network }, { votingEscrow: null })
  await Models.Setting.updateMany({ tokenAddress: address, network }, { $unset: { votingEscrow: 1 } })
  await Models.Lock.deleteMany({ tokenAddress: address, network })

  // the plugin sync crawls the token from its first block under the new token type
  const plugins = await Models.Plugin.find({ tokenAddress: address, network, status: IPluginStatus.installed })
  for (const plugin of plugins) {
    await RabbitMQHelper.sendMessage(EnumQueueName.plugins, {
      id: plugin.address,
      params: { address: plugin.address, network },
    })
  }
}

export const migrateBondedVotesTokensMigration: IMigration = {
  start: async () => {
    logger.info('Starting migration', llo({ migration: MIGRATION }))

    try {
      const tokens = await findBondedVotesTokens()

      for (const token of tokens) {
        await migrateBondedVotesToken(token)
        logger.verbose(
          'Migrated BondedVotes token',
          llo({ migration: MIGRATION, tokenAddress: token.address, network: token.network }),
        )
      }

      logger.info('Migration completed successfully', llo({ migration: MIGRATION, migrated: tokens.length }))
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
