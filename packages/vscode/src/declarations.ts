import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { VscxError } from "@vscx/core";

export interface ApiDeclarations {
  content: string;
  hash: string;
  source: string;
}

export interface ApiDeclarationSearchResult {
  hash: string;
  matchCount: number;
  matches: Array<{
    endLine: number;
    excerpt: string;
    startLine: number;
  }>;
  query: string;
  source: string;
}

export function readApiDeclarations(extensionDirPath: string): ApiDeclarations {
  const declarationFilePath = path.join(
    extensionDirPath,
    "dist",
    "vscode.d.ts",
  );
  const declarationFileContent = fs.readFileSync(declarationFilePath, "utf8");

  return {
    content: declarationFileContent,
    hash: createHash("sha256").update(declarationFileContent).digest("hex"),
    source: "bundled @types/vscode declaration for the extension engine baseline",
  };
}

export function searchApiDeclarations(
  extensionDirPath: string,
  query: string,
): ApiDeclarationSearchResult {
  if (query.trim().length === 0) {
    throw new VscxError("empty-query", "The declaration search query is empty.");
  }

  const apiDeclarations = readApiDeclarations(extensionDirPath);
  const declarationLines = apiDeclarations.content.split(/\r?\n/);
  const normalizedQuery = query.toLocaleLowerCase();
  const matchingLineIndexes = declarationLines
    .map((declarationLine, lineIndex) =>
      declarationLine.toLocaleLowerCase().includes(normalizedQuery)
        ? lineIndex
        : -1,
    )
    .filter((lineIndex) => lineIndex >= 0)
    .slice(0, 50);
  const matches = matchingLineIndexes.map((lineIndex) => {
    const startLineIndex = Math.max(0, lineIndex - 4);
    const endLineIndex = Math.min(declarationLines.length - 1, lineIndex + 8);

    return {
      endLine: endLineIndex + 1,
      excerpt: declarationLines.slice(startLineIndex, endLineIndex + 1).join("\n"),
      startLine: startLineIndex + 1,
    };
  });

  return {
    hash: apiDeclarations.hash,
    matchCount: matchingLineIndexes.length,
    matches,
    query,
    source: apiDeclarations.source,
  };
}
