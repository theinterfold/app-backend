// The slice of the Interfold coordinator and the CRISP program that the CRISP indexer reads

export const Interfold = {
  abi: [
    {
      anonymous: false,
      inputs: [
        { indexed: true, internalType: 'uint256', name: 'e3Id', type: 'uint256' },
        { indexed: false, internalType: 'bytes', name: 'plaintextOutput', type: 'bytes' },
        { indexed: false, internalType: 'bytes', name: 'proof', type: 'bytes' },
      ],
      name: 'PlaintextOutputPublished',
      type: 'event',
    },
    {
      anonymous: false,
      inputs: [
        { indexed: true, internalType: 'uint256', name: 'e3Id', type: 'uint256' },
        { indexed: false, internalType: 'enum IInterfold.E3Stage', name: 'failedAtStage', type: 'uint8' },
        { indexed: false, internalType: 'enum IInterfold.FailureReason', name: 'reason', type: 'uint8' },
      ],
      name: 'E3Failed',
      type: 'event',
    },
    {
      inputs: [{ internalType: 'uint256', name: 'e3Id', type: 'uint256' }],
      name: 'checkFailureCondition',
      outputs: [
        { internalType: 'bool', name: 'canFail', type: 'bool' },
        { internalType: 'enum IInterfold.FailureReason', name: 'reason', type: 'uint8' },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [{ internalType: 'uint256', name: 'e3Id', type: 'uint256' }],
      name: 'getE3Stage',
      outputs: [{ internalType: 'enum IInterfold.E3Stage', name: 'stage', type: 'uint8' }],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [{ internalType: 'uint256', name: 'e3Id', type: 'uint256' }],
      name: 'getFailureReason',
      outputs: [{ internalType: 'enum IInterfold.FailureReason', name: 'reason', type: 'uint8' }],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [{ internalType: 'uint256', name: 'e3Id', type: 'uint256' }],
      name: 'getE3',
      outputs: [
        {
          components: [
            { internalType: 'uint256', name: 'seed', type: 'uint256' },
            { internalType: 'enum IInterfold.CommitteeSize', name: 'committeeSize', type: 'uint8' },
            { internalType: 'uint256', name: 'requestBlock', type: 'uint256' },
            { internalType: 'uint256[2]', name: 'inputWindow', type: 'uint256[2]' },
            { internalType: 'bytes32', name: 'encryptionSchemeId', type: 'bytes32' },
            { internalType: 'contract IE3Program', name: 'e3Program', type: 'address' },
            { internalType: 'uint8', name: 'paramSet', type: 'uint8' },
            { internalType: 'bytes', name: 'customParams', type: 'bytes' },
            { internalType: 'contract IDecryptionVerifier', name: 'decryptionVerifier', type: 'address' },
            { internalType: 'contract IPkVerifier', name: 'pkVerifier', type: 'address' },
            { internalType: 'bytes32', name: 'committeePublicKey', type: 'bytes32' },
            { internalType: 'bytes32', name: 'ciphertextOutput', type: 'bytes32' },
            { internalType: 'bytes', name: 'plaintextOutput', type: 'bytes' },
            { internalType: 'address', name: 'requester', type: 'address' },
            { internalType: 'bytes32', name: 'ciphertextCommitment', type: 'bytes32' },
          ],
          internalType: 'struct E3',
          name: 'e3',
          type: 'tuple',
        },
      ],
      stateMutability: 'view',
      type: 'function',
    },
  ],
}

export const CrispProgram = {
  abi: [
    {
      inputs: [{ internalType: 'uint256', name: 'e3Id', type: 'uint256' }],
      name: 'votingPowerDivisorOf',
      outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
      stateMutability: 'view',
      type: 'function',
    },
  ],
}
