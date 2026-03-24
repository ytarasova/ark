import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInputEnhanced } from "../components/TextInputEnhanced.js";
import * as core from "../../core/index.js";
import { generateName, getAwsProfiles } from "../helpers.js";
import { SelectMenu } from "../components/SelectMenu.js";
import type { AsyncState } from "../hooks/useAsync.js";

type Step = "name" | "provider" | "image" | "size" | "arch" | "region" | "profile";

interface NewComputeFormProps {
  async: AsyncState;
  onDone: () => void;
}

const SIZE_OPTIONS = [
  { label: "Extra Small  (2 vCPU, 8 GB)", value: "xs" },
  { label: "Small        (4 vCPU, 16 GB)", value: "s" },
  { label: "Medium       (8 vCPU, 32 GB)", value: "m" },
  { label: "Large        (16 vCPU, 64 GB)", value: "l" },
  { label: "X-Large      (32 vCPU, 128 GB)", value: "xl" },
  { label: "2X-Large     (48 vCPU, 192 GB)", value: "xxl" },
  { label: "4X-Large     (64 vCPU, 256 GB)", value: "xxxl" },
];

const ARCH_OPTIONS = [
  { label: "x64 (Intel)", value: "x64" },
  { label: "arm (Graviton)", value: "arm" },
];

const REGION_OPTIONS = [
  { label: "US East (N. Virginia)", value: "us-east-1" },
  { label: "US East (Ohio)", value: "us-east-2" },
  { label: "US West (N. California)", value: "us-west-1" },
  { label: "US West (Oregon)", value: "us-west-2" },
  { label: "Europe (Ireland)", value: "eu-west-1" },
  { label: "Europe (London)", value: "eu-west-2" },
  { label: "Europe (Frankfurt)", value: "eu-central-1" },
  { label: "Asia (Mumbai)", value: "ap-south-1" },
  { label: "Asia (Singapore)", value: "ap-southeast-1" },
  { label: "Asia (Tokyo)", value: "ap-northeast-1" },
];

const PROVIDER_OPTIONS = [
  { label: "ec2", value: "ec2" },
  { label: "local", value: "local" },
  { label: "docker", value: "docker" },
];

export function NewComputeForm({ async: asyncState, onDone }: NewComputeFormProps) {
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState(generateName());
  const [provider, setProvider] = useState("");
  const [image, setImage] = useState("ubuntu:22.04");
  const [size, setSize] = useState("");
  const [arch, setArch] = useState("");
  const [region, setRegion] = useState("");

  useInput((input, key) => {
    if (key.escape) {
      onDone();
    }
  });

  const handleSubmitName = () => {
    if (!name.trim()) return;
    setStep("provider");
  };

  const handleSelectProvider = (item: { label: string; value: string }) => {
    setProvider(item.value);
    if (item.value === "ec2") {
      setStep("size");
    } else if (item.value === "docker") {
      setStep("image");
    } else {
      // Create non-EC2/non-Docker compute directly
      try {
        core.createCompute({ name: name.trim(), provider: item.value, config: {} });
      } catch (e: any) {
        asyncState.run("Create failed", async () => { throw e; });
      }
      onDone();
    }
  };

  // Docker: submit image name
  const handleSubmitImage = () => {
    const img = image.trim() || "ubuntu:22.04";
    try {
      core.createCompute({
        name: name.trim(),
        provider: "docker",
        config: { image: img },
      });
    } catch (e: any) {
      asyncState.run("Create failed", async () => { throw e; });
    }
    onDone();
  };

  const handleSelectSize = (item: { label: string; value: string }) => {
    setSize(item.value);
    setStep("arch");
  };

  const handleSelectArch = (item: { label: string; value: string }) => {
    setArch(item.value);
    setStep("region");
  };

  const handleSelectRegion = (item: { label: string; value: string }) => {
    setRegion(item.value);
    setStep("profile");
  };

  const handleSelectProfile = (item: { label: string; value: string }) => {
    try {
      core.createCompute({
        name: name.trim(),
        provider,
        config: {
          size,
          arch,
          region,
          ...(item.value ? { aws_profile: item.value } : {}),
        },
      });
    } catch (e: any) {
      asyncState.run("Create failed", async () => { throw e; });
    }
    onDone();
  };

  const profileOptions = getAwsProfiles().map((p) => ({ label: p, value: p }));

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color="cyan">{" New Compute "}</Text>
      <Text> </Text>

      {step === "name" && (
        <Box flexDirection="column">
          <Text>{"Compute name:"}</Text>
          <Box>
            <Text color="cyan">{"> "}</Text>
            <TextInputEnhanced
              value={name}
              onChange={setName}
              onSubmit={handleSubmitName}
            />
          </Box>
          <Text dimColor>{"  Enter to continue, Esc to cancel"}</Text>
        </Box>
      )}

      {step === "provider" && (
        <Box flexDirection="column">
          <Text dimColor>{`Name: ${name}`}</Text>
          <Text>{""}</Text>
          <Text>{"Provider:"}</Text>
          <SelectMenu items={PROVIDER_OPTIONS} onSelect={handleSelectProvider} />
          <Text dimColor>{"  Esc to cancel"}</Text>
        </Box>
      )}

      {step === "image" && (
        <Box flexDirection="column">
          <Text dimColor>{`Name: ${name}  Provider: docker`}</Text>
          <Text>{""}</Text>
          <Text>{"Docker image:"}</Text>
          <Box>
            <Text color="cyan">{"> "}</Text>
            <TextInputEnhanced
              value={image}
              onChange={setImage}
              onSubmit={handleSubmitImage}
            />
          </Box>
          <Text dimColor>{"  Enter to create (default: ubuntu:22.04), Esc to cancel"}</Text>
        </Box>
      )}

      {step === "size" && (
        <Box flexDirection="column">
          <Text dimColor>{`Name: ${name}  Provider: ${provider}`}</Text>
          <Text>{""}</Text>
          <Text>{"Instance size:"}</Text>
          <SelectMenu items={SIZE_OPTIONS} onSelect={handleSelectSize} />
          <Text dimColor>{"  Esc to cancel"}</Text>
        </Box>
      )}

      {step === "arch" && (
        <Box flexDirection="column">
          <Text dimColor>{`Name: ${name}  Provider: ${provider}  Size: ${size}`}</Text>
          <Text>{""}</Text>
          <Text>{"Architecture:"}</Text>
          <SelectMenu items={ARCH_OPTIONS} onSelect={handleSelectArch} />
          <Text dimColor>{"  Esc to cancel"}</Text>
        </Box>
      )}

      {step === "region" && (
        <Box flexDirection="column">
          <Text dimColor>{`Name: ${name}  Provider: ${provider}  Size: ${size}  Arch: ${arch}`}</Text>
          <Text>{""}</Text>
          <Text>{"AWS Region:"}</Text>
          <SelectMenu items={REGION_OPTIONS} onSelect={handleSelectRegion} limit={10} />
          <Text dimColor>{"  Esc to cancel"}</Text>
        </Box>
      )}

      {step === "profile" && (
        <Box flexDirection="column">
          <Text dimColor>{`Name: ${name}  Provider: ${provider}  Size: ${size}  Arch: ${arch}  Region: ${region}`}</Text>
          <Text>{""}</Text>
          <Text>{"AWS Profile:"}</Text>
          <SelectMenu items={profileOptions} onSelect={handleSelectProfile} />
          <Text dimColor>{"  Esc to cancel"}</Text>
        </Box>
      )}
    </Box>
  );
}
