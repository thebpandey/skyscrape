import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Manifest = {
  name: string;
  private?: boolean;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readManifest(directory: string): Manifest {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

const workspaces = ["."];

for (const parent of ["apps", "packages"]) {
  for (const entry of readdirSync(parent)) {
    const directory = join(parent, entry);
    if (existsSync(join(directory, "package.json"))) {
      workspaces.push(directory);
    }
  }
}

for (const directory of workspaces) {
  const manifest = readManifest(directory);
  assert.equal(manifest.private, true, `${manifest.name} must be private`);

  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const [name, version] of Object.entries(dependencies)) {
    const installed = readManifest(join(directory, "node_modules", name));
    if (version.startsWith("workspace:")) {
      assert.equal(installed.name, name, `${manifest.name} requires workspace package ${name}`);
    } else {
      assert.equal(installed.version, version, `${manifest.name} requires ${name}@${version}`);
    }
  }
}

console.log(`Verified direct dependency pins for ${workspaces.length} workspace manifests.`);
