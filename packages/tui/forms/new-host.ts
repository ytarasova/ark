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
        { label: "Extra Small  (2 vCPU, 8 GB)",    value: "xs" },
        { label: "Small        (4 vCPU, 16 GB)",   value: "s" },
        { label: "Medium       (8 vCPU, 32 GB)",   value: "m" },
        { label: "Large        (16 vCPU, 64 GB)",  value: "l" },
        { label: "X-Large      (32 vCPU, 128 GB)", value: "xl" },
        { label: "2X-Large     (48 vCPU, 192 GB)", value: "xxl" },
        { label: "4X-Large     (64 vCPU, 256 GB)", value: "xxxl" },
      ];
      const size = await selectOne("Instance Size", sizeOptions, 2);
      if (!size) { prompt.destroy(); renderAll(); return; }

      const archOptions = [
        { label: "x64 (Intel)",      value: "x64" },
        { label: "arm (Graviton)",   value: "arm" },
      ];
      const arch = await selectOne("Architecture", archOptions, 0);
      if (!arch) { prompt.destroy(); renderAll(); return; }

      const regionOptions = [
        { label: "US East (N. Virginia)",  value: "us-east-1" },
        { label: "US East (Ohio)",         value: "us-east-2" },
        { label: "US West (N. California)",value: "us-west-1" },
        { label: "US West (Oregon)",       value: "us-west-2" },
        { label: "Europe (Ireland)",       value: "eu-west-1" },
        { label: "Europe (London)",        value: "eu-west-2" },
        { label: "Europe (Frankfurt)",     value: "eu-central-1" },
        { label: "Asia (Mumbai)",          value: "ap-south-1" },
        { label: "Asia (Singapore)",       value: "ap-southeast-1" },
        { label: "Asia (Tokyo)",           value: "ap-northeast-1" },
      ];
      const region = await selectOrType("AWS Region", regionOptions, 0, prompt);
      if (!region) { prompt.destroy(); renderAll(); return; }

      const profiles = getAwsProfiles().map(p => ({ label: p, value: p }));
      const profile = await selectOrType("AWS Profile", profiles, 0, prompt);
      if (profile === null) { prompt.destroy(); renderAll(); return; }

      const { runSafe } = require("../async.js");
      runSafe("Create host", () => core.createHost({
        name, provider,
        config: {
          size, arch, region,
          ...(profile ? { aws_profile: profile } : {}),
        },
      }));
    } else {
      const { runSafe } = require("../async.js");
      runSafe("Create host", () => core.createHost({ name, provider, config: {} }));
    }

    prompt.destroy();
    renderAll();
  })();
}
