"use client";

import { useEffect, useState } from "react";
import { createSmartAccountClient } from "permissionless";
import { toSafeSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createPublicClient, encodeFunctionData, http, toHex } from "viem";
import { EntryPointVersion, entryPoint07Address } from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { useAccount } from "wagmi";
import { Address } from "~~/components/scaffold-eth";
import { useDeployedContractInfo } from "~~/hooks/scaffold-eth";
import { useChallengeState } from "~~/services/store/challengeStore";
import {
  hasStoredProof,
  hasStoredTransactionResult,
  loadProofFromLocalStorage,
  loadTransactionResultFromLocalStorage,
  saveTransactionResultToLocalStorage,
} from "~~/utils/proofStorage";
import { notification } from "~~/utils/scaffold-eth";

// Pimlico API key is pulled from your .env file
const pimlicoUrl = `https://api.pimlico.io/v2/${sepolia.id}/rpc?apikey=${process.env.NEXT_PUBLIC_PIMLICO_API_KEY}`;
const CHAIN_USED = sepolia;

// Using a public Sepolia RPC for the Smart Account Client
const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";

const pimlicoClient = createPimlicoClient({
  chain: CHAIN_USED,
  transport: http(pimlicoUrl),
  entryPoint: {
    address: entryPoint07Address,
    version: "0.7" as EntryPointVersion,
  },
});

/**
 * Checkpoint 10: Logic to create a sponsored Smart Account
 * This generates a fresh EOA as owner and wraps it in a Safe Smart Account.
 */
const createSmartAccount = async (): Promise<{
  smartAccountClient: any;
  smartAccount: `0x${string}`;
  walletOwner: `0x${string}`;
}> => {
  try {
    // 1. Generate a brand new burner EOA (The Remote Control)
    const privateKey = generatePrivateKey();
    const wallet = privateKeyToAccount(privateKey);

    const publicClient = createPublicClient({
      chain: CHAIN_USED,
      transport: http(RPC_URL),
    });

    // 2. Initialize the Safe Smart Account (The Vault)
    const account = await toSafeSmartAccount({
      client: publicClient,
      owners: [wallet],
      version: "1.4.1",
    });

    // 3. Create the client that talks to the Pimlico Bundler/Paymaster
    const smartAccountClient = createSmartAccountClient({
      account,
      chain: CHAIN_USED,
      bundlerTransport: http(pimlicoUrl),
      paymaster: pimlicoClient,
      userOperation: {
        estimateFeesPerGas: async () => {
          return (await pimlicoClient.getUserOperationGasPrice()).fast;
        },
      },
    });

    return {
      smartAccountClient,
      smartAccount: account.address as `0x${string}`,
      walletOwner: wallet.address as `0x${string}`,
    };
  } catch (error) {
    console.error("Error creating smart account:", error);
    throw error;
  }
};

/**
 * Checkpoint 10: Logic to submit the vote UserOperation
 * We encode the 'vote' function call and send it through the Smart Account.
 */
const voteOnSepolia = async ({
  proofData,
  contractInfo,
  contractAddress,
  smartAccountClient,
}: {
  proofData: any;
  contractInfo: any;
  contractAddress: any;
  smartAccountClient: any;
}): Promise<{ userOpHash: `0x${string}` }> => {
  if (!contractInfo && !contractAddress) throw new Error("Contract not found");

  // Encode the calldata for the Voting.sol 'vote' function
  // ORDER: [proof, nullifierHash, root, vote, depth]
  const callData = encodeFunctionData({
    abi: (contractInfo?.abi as any) || ([] as any),
    functionName: "vote",
    args: [
      toHex(proofData.proof), // bytes
      proofData.publicInputs[0], // _nullifierHash (bytes32)
      proofData.publicInputs[1], // _root (bytes32)
      proofData.publicInputs[2], // _vote (bytes32)
      proofData.publicInputs[3], // _depth (bytes32)
    ],
  });

  // Send the sponsored UserOperation
  const userOpHash = await smartAccountClient.sendTransaction({
    to: (contractAddress || contractInfo?.address) as `0x${string}`,
    data: callData,
    value: 0n,
  });

  return { userOpHash };
};

export const VoteWithBurnerSepolia = ({ contractAddress }: { contractAddress?: `0x${string}` }) => {
  const [smartAccount, setSmartAccount] = useState<`0x${string}` | null>(null);
  const [txStatus, setTxStatus] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [hasProofStored, setHasProofStored] = useState<boolean>(false);
  const [hasSuccessfulVote, setHasSuccessfulVote] = useState<boolean>(false);
  const [walletOwner, setWalletOwner] = useState<`0x${string}` | null>(null);
  const [smartAccountClient, setSmartAccountClient] = useState<any>(null);
  const [votedSmartAccount, setVotedSmartAccount] = useState<`0x${string}` | null>(null);
  const { proofData, setProofData } = useChallengeState();
  const { address: userAddress } = useAccount();

  const { data: contractInfo } = useDeployedContractInfo({ contractName: "Voting" });

  useEffect(() => {
    const effectiveContractAddress = contractAddress || contractInfo?.address;
    if (!effectiveContractAddress || !userAddress) {
      setSmartAccountClient(null);
      setSmartAccount(null);
      setWalletOwner(null);
    }
  }, [contractAddress, contractInfo?.address, userAddress]);

  useEffect(() => {
    const checkAndLoadStoredData = () => {
      const effectiveContractAddress = contractAddress || contractInfo?.address;
      if (effectiveContractAddress && userAddress) {
        const proofExists = hasStoredProof(effectiveContractAddress, userAddress);
        const transactionResultExists = hasStoredTransactionResult(effectiveContractAddress, userAddress);

        setHasProofStored(proofExists);

        if (proofExists && !proofData) {
          try {
            const storedProof = loadProofFromLocalStorage(effectiveContractAddress, userAddress);
            if (storedProof) setProofData(storedProof);
          } catch (error) {
            console.error("Error auto-loading proof:", error);
          }
        }

        if (transactionResultExists) {
          try {
            const storedResult = loadTransactionResultFromLocalStorage(effectiveContractAddress, userAddress);
            if (storedResult) {
              setTxStatus(storedResult.success ? "success" : "error");
              setHasSuccessfulVote(Boolean(storedResult.success));
              const SA_Address = storedResult.receipt?.smartAccountAddress as `0x${string}` | undefined;
              setVotedSmartAccount(SA_Address || null);
            }
          } catch (error) {
            console.error("Error loading transaction result:", error);
          }
        }
      }
    };
    checkAndLoadStoredData();
  }, [contractAddress, contractInfo?.address, userAddress, proofData, setProofData]);

  return (
    <div className="bg-base-100 shadow rounded-xl p-6 space-y-4">
      <div className="space-y-1 text-center">
        <h2 className="text-2xl font-bold">Vote (Sepolia)</h2>
        <p className="text-sm opacity-70 italic text-primary">Breaking the link: Identity via ZK, Gas via Paymaster.</p>
      </div>

      {hasSuccessfulVote && votedSmartAccount && (
        <div className="flex items-center gap-2 justify-center">
          <span className="text-sm font-semibold text-success">Voted Anonymous Account:</span>
          <Address address={votedSmartAccount} />
        </div>
      )}

      <div className="flex justify-center">
        <button
          className={`btn btn-primary ${txStatus === "pending" ? "loading" : ""}`}
          disabled={!hasProofStored || !proofData || txStatus === "pending" || hasSuccessfulVote}
          onClick={async () => {
            try {
              if (!proofData) return;
              setTxStatus("pending");
              const effectiveContractAddress = contractAddress || contractInfo?.address;

              let client = smartAccountClient;
              let currentSmartAccount = smartAccount;
              let currentWalletOwner = walletOwner;

              if (!client) {
                const created = await createSmartAccount();
                client = created.smartAccountClient;
                currentSmartAccount = created.smartAccount;
                currentWalletOwner = created.walletOwner;
                setSmartAccountClient(client);
                setSmartAccount(currentSmartAccount);
                setWalletOwner(currentWalletOwner);
              }

              const { userOpHash } = await voteOnSepolia({
                proofData,
                contractInfo,
                contractAddress,
                smartAccountClient: client,
              });

              const receipt = await pimlicoClient.waitForUserOperationReceipt({ hash: userOpHash });

              if (receipt.success) {
                setTxStatus("success");
                setHasSuccessfulVote(true);
                saveTransactionResultToLocalStorage(userOpHash, true, effectiveContractAddress!, userAddress!, {
                  ...receipt,
                  smartAccountAddress: currentSmartAccount,
                });
                setVotedSmartAccount(currentSmartAccount);
                notification.success("Anonymous vote cast successfully on Sepolia!");
              } else {
                setTxStatus("error");
                notification.error("User Operation failed.");
              }
            } catch (e) {
              console.error("Error voting:", e);
              setTxStatus("error");
              notification.error(e instanceof Error ? e.message : "Submission failed.");
            }
          }}
        >
          {txStatus === "pending"
            ? "Executing UserOp..."
            : hasSuccessfulVote
              ? "Ballot Cast ✅"
              : "Cast Anonymous Ballot"}
        </button>
      </div>
    </div>
  );
};
