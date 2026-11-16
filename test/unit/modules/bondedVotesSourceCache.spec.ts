import { Models } from '@dbModels'
import GovernanceBondedVotesHelper from '@helpers/governanceBondedVotes'
import logger from '@logger'
import BondedVotesSourceCache from '@modules/bondedVotesSourceCache'
import { PluginList } from '@test/mock/fakePlugins'
import { FakeToken } from '@test/mock/fakeToken'
import { IPluginInterfaceType, IPluginStatus, ITokenType, NetworksEnum } from '@types'
import { expect } from 'chai'
import { ethers } from 'ethers'
import * as sinon from 'sinon'
import { type SinonSandbox, type SinonStub } from 'sinon'

const network = NetworksEnum.ethereumMainnet
const tokenAddress = ethers.getAddress('0x4444444444444444444444444444444444444444')
const checkpoints = ethers.getAddress('0x5555555555555555555555555555555555555555')
const votesSource = ethers.getAddress('0x6666666666666666666666666666666666666666')
const escrow = ethers.getAddress('0x8888888888888888888888888888888888888888')

// strip the fixture timestamps so created docs get real ones, the cursor delta depends on it
const { createdAt: _pc, updatedAt: _pu, ...pluginFixture } = PluginList[0] as Record<string, any>
const { createdAt: _tc, updatedAt: _tu, ...tokenFixture } = FakeToken as Record<string, any>

const createPlugin = (overrides: Record<string, any> = {}) =>
  Models.Plugin.create({
    ...pluginFixture,
    interfaceType: IPluginInterfaceType.tokenVoting,
    status: IPluginStatus.installed,
    isSupported: true,
    tokenAddress,
    network,
    ...overrides,
  })

const createToken = (overrides: Record<string, any> = {}) =>
  Models.Token.create({
    ...tokenFixture,
    address: tokenAddress,
    type: ITokenType.bondedVotes,
    network,
    ...overrides,
  })

describe('Module: BondedVotesSourceCache', () => {
  let sandbox: SinonSandbox
  let getSourcesStub: SinonStub

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sandbox.stub(logger, 'warn')
    getSourcesStub = sandbox.stub(GovernanceBondedVotesHelper, 'getSources').resolves({
      checkpoints,
      votesSource,
      escrow,
    })
    BondedVotesSourceCache.clear()
  })

  afterEach(() => {
    sandbox.restore()
    BondedVotesSourceCache.clear()
  })

  it('should know the token, its checkpoints, votes source and escrow, in any casing', async () => {
    await createToken()
    await createPlugin()

    await BondedVotesSourceCache.refresh(network)

    for (const address of [tokenAddress, checkpoints, votesSource, escrow]) {
      expect(BondedVotesSourceCache.isSource(network, address)).to.be.true
      expect(BondedVotesSourceCache.isSource(network, address.toLowerCase())).to.be.true
    }
    expect(BondedVotesSourceCache.isSource(network, ethers.getAddress('0x9999999999999999999999999999999999999999'))).to
      .be.false
  })

  it('should skip the escrow of a votes source that has none', async () => {
    getSourcesStub.resolves({ checkpoints, votesSource, escrow: null })
    await createToken()
    await createPlugin()

    await BondedVotesSourceCache.refresh(network)

    expect(BondedVotesSourceCache.isSource(network, votesSource)).to.be.true
    expect(BondedVotesSourceCache.isSource(network, escrow)).to.be.false
  })

  it('should ignore a BondedVotes token that no installed supported plugin uses', async () => {
    await createToken()
    const plugin = await createPlugin()
    await plugin.update({ status: IPluginStatus.uninstalled })

    await BondedVotesSourceCache.refresh(network)

    expect(BondedVotesSourceCache.isSource(network, votesSource)).to.be.false
    expect(getSourcesStub.called).to.be.false
  })

  it('should ignore tokens that are not BondedVotes', async () => {
    await createToken({ type: ITokenType.ERC20 })
    await createPlugin()

    await BondedVotesSourceCache.refresh(network)

    expect(BondedVotesSourceCache.isSource(network, votesSource)).to.be.false
    expect(getSourcesStub.called).to.be.false
  })

  it('should pick up a token detected after the initial load', async () => {
    await BondedVotesSourceCache.refresh(network)
    expect(BondedVotesSourceCache.isSource(network, votesSource)).to.be.false

    const token = await createToken({ type: ITokenType.escrowAdapter })
    await createPlugin()
    await BondedVotesSourceCache.refresh(network)
    expect(BondedVotesSourceCache.isSource(network, votesSource)).to.be.false

    // the token migration retypes tokens detected as escrow adapters
    await token.update({ type: ITokenType.bondedVotes })
    await BondedVotesSourceCache.refresh(network)

    expect(BondedVotesSourceCache.isSource(network, votesSource)).to.be.true
  })

  it('should drop the sources once the only plugin is uninstalled', async () => {
    await createToken()
    const plugin = await createPlugin()
    await BondedVotesSourceCache.refresh(network)
    expect(BondedVotesSourceCache.isSource(network, votesSource)).to.be.true

    await plugin.update({ status: IPluginStatus.uninstalled })
    await BondedVotesSourceCache.refresh(network)

    expect(BondedVotesSourceCache.isSource(network, votesSource)).to.be.false
  })

  it('should retry a token whose sources could not be read on the next refresh', async () => {
    getSourcesStub.onFirstCall().rejects(new Error('execution reverted'))
    await createToken()
    await createPlugin()

    await BondedVotesSourceCache.refresh(network)
    expect(BondedVotesSourceCache.isSource(network, votesSource)).to.be.false

    await BondedVotesSourceCache.refresh(network)
    expect(BondedVotesSourceCache.isSource(network, votesSource)).to.be.true
  })

  it('should keep the sources of the healthy tokens when another one cannot be read', async () => {
    const lookAlike = ethers.getAddress('0x9999999999999999999999999999999999999999')
    getSourcesStub.callsFake(async (token: string) => {
      if (token === lookAlike) throw new Error('execution reverted')
      return { checkpoints, votesSource, escrow }
    })
    await createToken()
    await createToken({ address: lookAlike, id: 'look-alike-token-id' })
    await createPlugin()
    await createPlugin({
      id: 'second-plugin-id',
      address: '0xBf8dE4316E2778E26b12dad8906467b23BB9A200',
      transactionHash: '0x6f3e8a941b2140d72e402e35078fd459478222e146aa6d6bd6832d322de5dd00',
      tokenAddress: lookAlike,
    })

    await BondedVotesSourceCache.refresh(network)

    expect(BondedVotesSourceCache.isSource(network, votesSource)).to.be.true
    expect(BondedVotesSourceCache.isSource(network, lookAlike)).to.be.false
  })

  it('should keep networks isolated', async () => {
    await createToken()
    await createPlugin()

    await BondedVotesSourceCache.refresh(network)
    await BondedVotesSourceCache.refresh(NetworksEnum.polygonMainnet)

    expect(BondedVotesSourceCache.isSource(network, votesSource)).to.be.true
    expect(BondedVotesSourceCache.isSource(NetworksEnum.polygonMainnet, votesSource)).to.be.false
  })

  it('should only query the token delta window, and no plugins without BondedVotes tokens, after the first load', async () => {
    const tokenFindSpy = sandbox.spy(Models.Token, 'find')
    const pluginDistinctSpy = sandbox.spy(Models.Plugin, 'distinct')

    await BondedVotesSourceCache.refresh(network)
    await BondedVotesSourceCache.refresh(network)

    expect(tokenFindSpy.calledOnce).to.be.true
    expect(tokenFindSpy.firstCall.args[0]).to.have.property('updatedAt')
    expect(pluginDistinctSpy.called).to.be.false
  })
})
