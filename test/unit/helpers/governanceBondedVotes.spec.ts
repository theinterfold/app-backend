import GovernanceBondedVotesHelper from '@helpers/governanceBondedVotes'
import BottleneckModule from '@modules/bottleneck'
import ProviderModule from '@modules/provider'
import { NetworksEnum } from '@types'
import { expect } from 'chai'
import proxyquire from 'proxyquire'
import * as sinon from 'sinon'
import { SinonSandbox, SinonStub } from 'sinon'

describe('Helpers: GovernanceBondedVotes', () => {
  let sandbox: SinonSandbox

  const network = NetworksEnum.ethereumSepolia
  const checkpoints = '0x5555555555555555555555555555555555555555'
  const votesSource = '0x6666666666666666666666666666666666666666'
  const escrow = '0x8888888888888888888888888888888888888888'
  const zero = '0x0000000000000000000000000000000000000000'

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sandbox
      .stub(BottleneckModule, 'getNodeLimiter')
      .returns({ schedule: async (fn: () => Promise<any>) => fn() } as any)
  })

  afterEach(() => {
    sandbox?.restore()
  })

  describe('getSources', () => {
    const load = (escrowAddress: string) => {
      const reads: Record<string, string> = { checkpoints, votesSource, escrow: escrowAddress }
      const { default: Helper } = proxyquire.noCallThru()('@helpers/governanceBondedVotes', {
        ethers: {
          Contract: function () {
            return new Proxy({}, { get: (_target, method: string) => async () => reads[method] })
          },
        },
      })
      return Helper as typeof GovernanceBondedVotesHelper
    }

    beforeEach(() => {
      sandbox.stub(ProviderModule, 'getAnyRpcProvider').returns({} as any)
    })

    it('should read the checkpoints, the votes source and the escrow behind it', async () => {
      const sources = await load(escrow).getSources('0x4141414141414141414141414141414141414141', network)

      expect(sources).to.deep.equal({ checkpoints, votesSource, escrow })
    })

    it('should report no escrow when the token votes for itself', async () => {
      const sources = await load(zero).getSources('0x4242424242424242424242424242424242424242', network)

      expect(sources.escrow).to.equal(null)
    })
  })

  describe('getStartBlock', () => {
    const token = '0x4444444444444444444444444444444444444444'
    const deployedAt: Record<string, number> = {
      [token]: 5000,
      [checkpoints]: 4900,
      [votesSource]: 120,
      [escrow]: 100,
    }
    let getCodeStub: SinonStub

    beforeEach(() => {
      getCodeStub = sandbox.stub().callsFake(async (address: string, block: number) => {
        return block >= deployedAt[address] ? '0x6080' : '0x'
      })
      sandbox.stub(ProviderModule, 'getAnyRpcProvider').returns({
        getCode: getCodeStub,
        getBlockNumber: async () => 6000,
      } as any)
    })

    it('should start at the earliest deployment of the contracts the crawl reads', async () => {
      sandbox.stub(GovernanceBondedVotesHelper, 'getSources').resolves({ checkpoints, votesSource, escrow } as any)

      const startBlock = await GovernanceBondedVotesHelper.getStartBlock(token, network)

      expect(startBlock).to.equal(100)
    })

    it('should ignore a missing escrow and read the creation blocks once per token', async () => {
      const otherToken = '0x4545454545454545454545454545454545454545'
      deployedAt[otherToken] = 300
      const getSourcesStub = sandbox
        .stub(GovernanceBondedVotesHelper, 'getSources')
        .resolves({ checkpoints, votesSource: otherToken, escrow: null })

      expect(await GovernanceBondedVotesHelper.getStartBlock(otherToken, network)).to.equal(300)
      const calls = getCodeStub.callCount
      expect(await GovernanceBondedVotesHelper.getStartBlock(otherToken, network)).to.equal(300)

      expect(getCodeStub.callCount).to.equal(calls)
      expect(getSourcesStub.calledOnce).to.be.true
    })

    it('should throw when a contract has no code at the head', async () => {
      const gone = '0x4646464646464646464646464646464646464646'
      sandbox.stub(GovernanceBondedVotesHelper, 'getSources').resolves({ checkpoints, votesSource: gone, escrow: null })

      let error: Error | undefined
      try {
        await GovernanceBondedVotesHelper.getStartBlock(gone, network)
      } catch (err) {
        error = err as Error
      }

      expect(error?.message).to.contain(gone)
    })
  })
})
