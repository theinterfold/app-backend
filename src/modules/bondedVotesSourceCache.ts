import { Models } from '@dbModels'
import GovernanceBondedVotesHelper from '@helpers/governanceBondedVotes'
import logger from '@logger'
import { IPluginStatus, ITokenType, type NetworksEnum } from '@types'

const llo = logger.logMeta.bind(null, { service: 'module:BondedVotesSourceCache' })

/**
 * Re-read window when advancing the token cursor, to absorb clock skew between writer processes and
 * same-millisecond updates. Map upserts/removals are idempotent so overlap is free.
 */
const CURSOR_OVERLAP_MS = 60 * 1000

interface IBondedVotesSourceState {
  /** BondedVotes tokens of the network by lowercase address, as stored (checksummed). */
  bondedByLower: Map<string, string>
  /** Lowercase addresses of the contracts feeding an installed, supported BondedVotes token. */
  sources: Set<string>
  tokenCursor: Date | null
  refreshing: Promise<void> | null
}

/**
 * Per-network cache of the contracts whose events move the voting power of an installed BondedVotes token: the
 * token, its checkpoints, and the votes source it wraps with the escrow behind it.
 *
 * The live crawler matches logs against it, as with TokenEligibilityCache, because the plugin crawl of a token ends
 * and the sources keep emitting. The BondedVotes tokens are tracked from Token.updatedAt deltas (so no per-tick
 * scan of the tokens); whether a plugin uses them, and what their sources are, is re-read on each refresh because
 * the plugin query only runs for the few BondedVotes tokens and the sources are cached by the helper.
 */
class BondedVotesSourceCache {
  private readonly states = new Map<NetworksEnum, IBondedVotesSourceState>()

  private getState(network: NetworksEnum): IBondedVotesSourceState {
    let state = this.states.get(network)
    if (!state) {
      state = { bondedByLower: new Map(), sources: new Set(), tokenCursor: null, refreshing: null }
      this.states.set(network, state)
    }
    return state
  }

  async refresh(network: NetworksEnum): Promise<void> {
    const state = this.getState(network)
    if (state.refreshing) return state.refreshing

    state.refreshing = this.doRefresh(network, state).finally(() => {
      state.refreshing = null
    })
    return state.refreshing
  }

  private async doRefresh(network: NetworksEnum, state: IBondedVotesSourceState): Promise<void> {
    await this.refreshTokens(network, state)
    await this.refreshSources(network, state)
  }

  private async refreshTokens(network: NetworksEnum, state: IBondedVotesSourceState): Promise<void> {
    // Snapshot BEFORE the query so the initial cursor can never be newer than a document the scan raced with.
    const queryStartedAt = new Date()

    if (!state.tokenCursor) {
      const addresses = await Models.Token.distinct('address', { network, type: ITokenType.bondedVotes })
      for (const address of addresses) {
        if (address) state.bondedByLower.set(address.toLowerCase(), address)
      }
      state.tokenCursor = queryStartedAt
      return
    }

    const changed = await Models.Token.find(
      { network, updatedAt: { $gte: new Date(state.tokenCursor.getTime() - CURSOR_OVERLAP_MS) } },
      { address: 1, type: 1, updatedAt: 1 },
    ).lean()

    let cursor = state.tokenCursor > queryStartedAt ? state.tokenCursor : queryStartedAt
    for (const token of changed as unknown as Array<{ address?: string; type?: ITokenType; updatedAt?: Date }>) {
      if (token.address) {
        const lower = token.address.toLowerCase()
        if (token.type === ITokenType.bondedVotes) state.bondedByLower.set(lower, token.address)
        else state.bondedByLower.delete(lower)
      }
      if (token.updatedAt && token.updatedAt > cursor) cursor = token.updatedAt
    }

    state.tokenCursor = cursor
  }

  private async refreshSources(network: NetworksEnum, state: IBondedVotesSourceState): Promise<void> {
    if (state.bondedByLower.size === 0) {
      state.sources = new Set()
      return
    }

    // Anyone can deploy a token that reports another token's sources, so only tokens a DAO runs a plugin on count.
    const used = await Models.Plugin.distinct('tokenAddress', {
      network,
      tokenAddress: { $in: [...state.bondedByLower.values()] },
      status: IPluginStatus.installed,
      isSupported: true,
    })

    const sources = new Set<string>()
    await Promise.all(
      used.map(async token => {
        try {
          const { checkpoints, votesSource, escrow } = await GovernanceBondedVotesHelper.getSources(token, network)
          for (const address of [token, checkpoints, votesSource, escrow]) {
            if (address) sources.add(address.toLowerCase())
          }
        } catch (error) {
          // retried on the next refresh, the helper rate limits reading a failing token
          logger.warn('Cannot read the sources of a BondedVotes token, skipping it', llo({ token, network, error }))
        }
      }),
    )
    state.sources = sources
  }

  /** Whether the contract feeds the voting power of an installed BondedVotes token. Accepts any casing. */
  isSource(network: NetworksEnum, address: string): boolean {
    return this.getState(network).sources.has(address.toLowerCase())
  }

  clear(): void {
    this.states.clear()
  }
}

export default new BondedVotesSourceCache()
