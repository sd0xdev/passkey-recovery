// ABI fragments the sidecar reads, simulates or builds. Nothing here is sent upstream as a write.
import { parseAbi, toEventSelector } from 'viem';

export const EP_ABI = parseAbi([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function depositTo(address account) payable',
  'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,uint256 callGasLimit,uint256 verificationGasLimit,uint256 preVerificationGas,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,bytes paymasterAndData,bytes signature)[] ops, address beneficiary)',
  'function simulateValidation((address sender,uint256 nonce,bytes initCode,bytes callData,uint256 callGasLimit,uint256 verificationGasLimit,uint256 preVerificationGas,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,bytes paymasterAndData,bytes signature) userOp)',
  'error ValidationResult((uint256 preOpGas,uint256 prefund,bool sigFailed,uint48 validAfter,uint48 validUntil,bytes paymasterContext) returnInfo,(uint256 stake,uint256 unstakeDelaySec) senderInfo,(uint256 stake,uint256 unstakeDelaySec) factoryInfo,(uint256 stake,uint256 unstakeDelaySec) paymasterInfo)',
  'error FailedOp(uint256 opIndex, string reason)',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  'event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)',
  'event BeforeExecution()',
]);

export const WALLET_READ_ABI = parseAbi([
  'function ownerAtIndex(uint256 index) view returns (bytes)',
  'function nextOwnerIndex() view returns (uint256)',
  'function removedOwnersCount() view returns (uint256)',
]);

export const FACTORY_ABI = parseAbi([
  'function createAccount(bytes[] owners, uint256 nonce) payable returns (address)',
  'function getAddress(bytes[] owners, uint256 nonce) view returns (address)',
  'function initCodeHash() view returns (bytes32)',
]);

export const USER_OP_EVENT_TOPIC = toEventSelector('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)');

export const ERC20_READ_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
