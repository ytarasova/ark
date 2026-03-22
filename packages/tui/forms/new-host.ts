import blessed from "neo-blessed";
import * as core from "../../core/index.js";
import { screen } from "../layout.js";
import { selectOne, selectOrType } from "./select.js";
import { generateName, getAwsProfiles } from "../helpers.js";
import { renderAll } from "../render/index.js";

export function showNewHostForm() {
  const prompt = blessed.prompt({
    parent: screen,
    top: "center", left: "center", width: 70, height: 8,
    border: { type: "line" },
    style: { border: { fg: "cyan" }, bg: "black" },
    tags: true,
  });

  const ask = (question: string, defaultVal: string): Promise<string | null> =>
    new Promise((resolve) => {
      prompt.input(`{bold}New Host{/bold}\n\n${question}`, defaultVal, (err, value) => {
        if (err || value === undefined || value === null) resolve(null);
        else resolve(value.trim());
      });
    });

  (async () => {
    const name = await ask("Host name:", generateName());
    if (!name) { prompt.destroy(); renderAll(); return; }

    const provider = await selectOne("Provider", ["ec2", "local", "docker"], 0);
    if (!provider) { prompt.destroy(); renderAll(); return; }

    if (provider === "ec2") {
      const sizeOptions = [
        "xs  - Extra Small (2 vCPU, 8 GB)",
        "s   - Small (4 vCPU, 16 GB)",
        "m   - Medium (8 vCPU, 32 GB)",
        "l   - Large (16 vCPU, 64 GB)",
        "xl  - X-Large (32 vCPU, 128 GB)",
        "xxl - 2X-Large (48 vCPU, 192 GB)",
        "xxxl— 4X-Large (64 vCPU, 256 GB)",
      ];
      const sizeChoice = await selectOne("Instance Size", sizeOptions, 2);
      if (!sizeChoice) { prompt.destroy(); renderAll(); return; }
      const size = sizeChoice.split(/\s+-\s/)[0].trim();

      const arch = await selectOne("Architecture", ["x64 (Intel)", "arm (Graviton)"], 0);
      if (!arch) { prompt.destroy(); renderAll(); return; }
      const archVal = arch.startsWith("arm") ? "arm" : "x64";

      const regions = [
        "us-east-1      - N. Virginia",
        "us-east-2      - Ohio",
        "us-west-1      - N. California",
        "us-west-2      - Oregon",
        "eu-west-1      - Ireland",
        "eu-west-2      - London",
        "eu-central-1   - Frankfurt",
        "ap-south-1     - Mumbai",
        "ap-southeast-1 - Singapore",
        "ap-northeast-1 - Tokyo",
      ];
      const regionChoice = await selectOrType("AWS Region", regions, 0, prompt);
      if (!regionChoice) { prompt.destroy(); renderAll(); return; }
      const region = regionChoice.split(/\s+-\s/)[0].trim();

      const awsProfiles = getAwsProfiles();
      const profileChoice = await selectOrType("AWS Profile", awsProfiles, 0, prompt);
      if (profileChoice === null) { prompt.destroy(); renderAll(); return; }

      try {
        core.createHost({
          name, provider,
          config: {
            size, arch: archVal,
            region: region || "us-east-1",
            ...(profileChoice ? { aws_profile: profileChoice } : {}),
          },
        });
      } catch { /* duplicate name etc */ }
    } else {
      try {
        core.createHost({ name, provider, config: {} });
      } catch { /* duplicate name etc */ }
    }

    prompt.destroy();
    renderAll();
  })();
}
