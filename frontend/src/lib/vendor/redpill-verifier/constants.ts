import type { Abi } from 'viem'
import type { NetworkConfig, NetworkKey } from './types.js'

export const API_BASE = 'https://api.redpill.ai'
export const NVIDIA_NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu'
export const PHALA_TDX_VERIFIER_URL = 'https://cloud-api.phala.network/api/v1/attestations/verify'
export const SIGSTORE_SEARCH_BASE = 'https://search.sigstore.dev/?hash='
export const DEFAULT_MODEL = 'phala/gpt-oss-120b'

export const AUTOMATA_NETWORKS: Record<NetworkKey, NetworkConfig> = {
  'automata-mainnet': {
    name: 'Automata Mainnet',
    chainId: 65536,
    rpc: 'https://rpc.ata.network',
    contract: '0xE26E11B257856B0bEBc4C759aaBDdea72B64351F',
    explorer: 'https://explorer.ata.network',
  },
  'automata-testnet': {
    name: 'Automata Testnet',
    chainId: 1398243,
    rpc: 'https://1rpc.io/ata/testnet',
    contract: '0xefE368b17D137E86298eec8EbC5502fb56d27832',
    explorer: 'https://explorer-testnet.ata.network',
  },
  sepolia: {
    name: 'Sepolia',
    chainId: 11155111,
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    contract: '0x76A3657F2d6c5C66733e9b69ACaDadCd0B68788b',
    explorer: 'https://sepolia.etherscan.io',
  },
  holesky: {
    name: 'Holesky',
    chainId: 17000,
    rpc: 'https://ethereum-holesky-rpc.publicnode.com',
    contract: '0x133303659F51d75ED216FD98a0B70CbCD75339b2',
    explorer: 'https://holesky.etherscan.io',
  },
}

export const DCAP_VERIFY_ABI = [
  {
    inputs: [{ name: 'data', type: 'bytes' }],
    name: 'verifyAndAttestOnChain',
    outputs: [
      { name: '', type: 'bool' },
      { name: '', type: 'bytes' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const satisfies Abi

export const PROOF_STORE_ABI = [
  {
    inputs: [{ name: '_dcapVerifier', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'constructor',
  },
  {
    inputs: [
      { name: 'quote', type: 'bytes' },
      { name: 'signingAddress', type: 'address' },
    ],
    name: 'verifyAndStore',
    outputs: [{ name: 'isValid', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'quoteHash', type: 'bytes32' }],
    name: 'getProof',
    outputs: [
      {
        components: [
          { name: 'quoteHash', type: 'bytes32' },
          { name: 'signingAddress', type: 'address' },
          { name: 'isValid', type: 'bool' },
          { name: 'timestamp', type: 'uint256' },
          { name: 'blockNumber', type: 'uint256' },
          { name: 'submitter', type: 'address' },
        ],
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'proofCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'quoteHash', type: 'bytes32' },
      { indexed: true, name: 'signingAddress', type: 'address' },
      { indexed: false, name: 'isValid', type: 'bool' },
      { indexed: false, name: 'timestamp', type: 'uint256' },
      { indexed: false, name: 'submitter', type: 'address' },
    ],
    name: 'ProofStored',
    type: 'event',
  },
] as const satisfies Abi
