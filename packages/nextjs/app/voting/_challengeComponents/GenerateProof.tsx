"use client";

import { useState } from "react";
import { UltraHonkBackend } from "@aztec/bb.js";
// @ts-ignore
import { Noir } from "@noir-lang/noir_js";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon1, poseidon2 } from "poseidon-lite";
import { useAccount } from "wagmi";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { useChallengeState } from "~~/services/store/challengeStore";
import { hasStoredProof, loadCommitmentFromLocalStorage, saveProofToLocalStorage } from "~~/utils/proofStorage";
import { notification } from "~~/utils/scaffold-eth";

const generateProof = async (
  _root: bigint,
  _vote: boolean,
  _depth: number,
  _nullifier: string,
  _secret: string,
  _index: number,
  _leaves: any[],
  _circuitData: any,
) => {
  const nullifierHash = poseidon1([BigInt(_nullifier)]);
  const calculatedTree = new LeanIMT((a: bigint, b: bigint) => poseidon2([a, b]));

  // ✅ Sort events by index field to ensure correct chronological order
  const sortedLeaves = _leaves
    .map(event => ({
      index: Number(event?.args.index),
      value: event?.args.value,
    }))
    .sort((a, b) => a.index - b.index);

  const leafValues = sortedLeaves.map(item => item.value);
  calculatedTree.insertMany(leafValues as bigint[]);

  // 🚨 ROOT GUARDRAIL
  const localRoot = calculatedTree.root;
  if (localRoot !== _root) {
    console.error("❌ ROOT MISMATCH!");
    throw new Error(
      `Tree Mismatch: Local root (${localRoot}) doesn't match contract (${_root}). Found ${leafValues.length} leaves.`,
    );
  }

  const calculatedProof = calculatedTree.generateProof(_index);
  const sibs = calculatedProof.siblings.map(sib => sib.toString());

  const lengthDiff = 16 - sibs.length;
  for (let i = 0; i < lengthDiff; i++) {
    sibs.push("0");
  }

  const input = {
    nullifier_hash: nullifierHash.toString(),
    nullifier: BigInt(_nullifier).toString(),
    secret: BigInt(_secret).toString(),
    root: _root.toString(),
    vote: _vote,
    depth: _depth.toString(),
    index: _index.toString(),
    siblings: sibs,
  };

  try {
    const noir = new Noir(_circuitData);
    const { witness } = await noir.execute(input);
    const honk = new UltraHonkBackend(_circuitData.bytecode, { threads: 1 });
    const originalLog = console.log;
    console.log = () => {};
    const { proof, publicInputs } = await honk.generateProof(witness, { keccak: true });
    console.log = originalLog;
    return { proof, publicInputs };
  } catch (error) {
    console.error("ZK Error:", error);
    throw error;
  }
};

export const GenerateProof = ({ leafEvents = [] }: { leafEvents?: any[] }) => {
  const [isLoading, setIsLoading] = useState(false);
  const { commitmentData, setProofData, voteChoice } = useChallengeState();
  const { address: userAddress, isConnected } = useAccount();
  const { data: deployedContractData } = useDeployedContractInfo({ contractName: "Voting" });

  const [nullifierInput, setNullifierInput] = useState<string>("");
  const [secretInput, setSecretInput] = useState<string>("");
  const [indexInput, setIndexInput] = useState<string>("");

  const { data: votingData } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getVotingData",
  });

  const root = votingData?.[6];
  const treeDepth = votingData?.[5];

  const { data: voterData } = useScaffoldReadContract({
    contractName: "Voting",
    functionName: "getVoterData",
    args: [userAddress as `0x${string}`],
  });

  const isVoter = voterData?.[0];
  const hasRegistered = voterData?.[1];
  const canVote = Boolean(isConnected && isVoter === true && hasRegistered === true);
  const hasExistingProof = hasStoredProof(deployedContractData?.address, userAddress);

  const getCircuitDataAndGenerateProof = async () => {
    setIsLoading(true);
    try {
      const storedCommitment =
        deployedContractData?.address && userAddress
          ? loadCommitmentFromLocalStorage(deployedContractData.address, userAddress)
          : null;

      if ((!nullifierInput || !secretInput || indexInput?.trim() === "") && storedCommitment) {
        setNullifierInput(storedCommitment.nullifier);
        setSecretInput(storedCommitment.secret);
        setIndexInput(storedCommitment.index?.toString() ?? "");
      }

      let fetchedCircuitData: any;
      const response = await fetch("/api/circuit");
      if (response.ok) {
        fetchedCircuitData = await response.json();
      } else {
        const staticRes = await fetch("circuits.json");
        fetchedCircuitData = await staticRes.json();
      }

      const effNull = (nullifierInput?.trim() || commitmentData?.nullifier || storedCommitment?.nullifier)?.trim();
      const effSec = (secretInput?.trim() || commitmentData?.secret || storedCommitment?.secret)?.trim();
      const effIdx =
        indexInput?.trim() !== "" ? Number(indexInput) : (commitmentData?.index ?? storedCommitment?.index);

      if (voteChoice === null) throw new Error("Select Yes/No first");
      if (!effNull || !effSec || effIdx === undefined) throw new Error("Missing commitment data.");

      const result = await generateProof(
        root as bigint,
        voteChoice,
        Number(treeDepth),
        effNull,
        effSec,
        effIdx,
        leafEvents,
        fetchedCircuitData,
      );

      setProofData(result);
      saveProofToLocalStorage(result, deployedContractData?.address, voteChoice, userAddress);
      notification.success("Proof Ready!");
    } catch (error) {
      console.error(error);
      notification.error((error as Error).message || "Proving failed");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-base-100 shadow rounded-xl p-6 space-y-5">
      <div className="space-y-1 text-center">
        <h2 className="text-2xl font-bold">Generate ZK Proof</h2>
        <p className="text-sm opacity-70 italic">Math: Poseidon2 | Prover: UltraHonk</p>
      </div>
      <div className="flex justify-center">
        <button
          className={`btn ${canVote && !hasExistingProof && voteChoice !== null ? "btn-primary" : "btn-disabled"}`}
          onClick={getCircuitDataAndGenerateProof}
          disabled={isLoading || !canVote || hasExistingProof || voteChoice === null}
        >
          {isLoading ? (
            <>
              <span className="loading loading-spinner loading-xs"></span> Generating...
            </>
          ) : hasExistingProof ? (
            "Proof Ready ✅"
          ) : (
            "Generate Proof"
          )}
        </button>
      </div>
    </div>
  );
};
