import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fetchRegulationHtml } from "../ingestion/eurlex";

/**
 * Tests for EUR-Lex ingestion, focusing on path traversal vulnerability mitigation.
 * 
 * The security fix validates that file paths cannot escape the intended directory
 * using path traversal techniques (e.g., ../, absolute paths).
 * 
 * The vulnerability exists when a malicious celex parameter causes the code to
 * read files outside the intended data/eurlex directory. The fix validates that
 * resolved paths stay within the allowed directory before reading.
 */

describe("fetchRegulationHtml - path traversal security", () => {
  const testDataDir = path.resolve(__dirname, "../../data/eurlex");
  const testFile = path.join(testDataDir, "32022R2554.html");
  const testContent = "<html><body>Test DORA regulation</body></html>";
  
  // Create files that would be accessed via path traversal
  // localFilePath constructs: path.resolve(__dirname, "../../data/eurlex", `${celex}.html`)
  // So "../sensitive" would resolve to "../../data/sensitive.html"
  const parentDir = path.resolve(__dirname, "../../data");
  const traversalTargetFile = path.join(parentDir, "sensitive.html");
  const traversalContent = "<html>SENSITIVE DATA</html>";

  beforeAll(() => {
    // Create test directory and file
    if (!fs.existsSync(testDataDir)) {
      fs.mkdirSync(testDataDir, { recursive: true });
    }
    fs.writeFileSync(testFile, testContent, "utf-8");
    
    // Create a target file that path traversal would try to access
    fs.writeFileSync(traversalTargetFile, traversalContent, "utf-8");
  });

  afterAll(() => {
    // Clean up test files
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
    if (fs.existsSync(traversalTargetFile)) {
      fs.unlinkSync(traversalTargetFile);
    }
  });

  it("loads valid local file successfully", async () => {
    const html = await fetchRegulationHtml("32022R2554");
    expect(html).toBe(testContent);
  });

  it("rejects path traversal with ../ to access parent directory", async () => {
    // Attempt to traverse up and access sensitive.html in parent directory
    // The file exists at ../../data/sensitive.html, so without the fix this would read it
    await expect(
      fetchRegulationHtml("../sensitive")
    ).rejects.toThrow("Invalid file path");
  });

  it("rejects path traversal with multiple ../ levels", async () => {
    // Create a file several levels up to test multiple traversals
    // This would resolve to ../../secret.html (backend/secret.html)
    const deepTarget = path.resolve(__dirname, "../../secret.html");
    const deepContent = "<html>SECRET</html>";
    
    fs.writeFileSync(deepTarget, deepContent, "utf-8");
    
    try {
      await expect(
        fetchRegulationHtml("../../secret")
      ).rejects.toThrow("Invalid file path");
    } finally {
      if (fs.existsSync(deepTarget)) {
        fs.unlinkSync(deepTarget);
      }
    }
  });

  it("rejects absolute path attempts", async () => {
    // Create a temp file with absolute path
    const absPath = path.resolve("/tmp/test-eurlex-abs.html");
    fs.writeFileSync(absPath, "absolute path test", "utf-8");
    
    try {
      // Try to access it via absolute path
      await expect(
        fetchRegulationHtml("/tmp/test-eurlex-abs")
      ).rejects.toThrow("Invalid file path");
    } finally {
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
      }
    }
  });

  it("allows valid celex identifiers with numbers and letters", async () => {
    // Valid CELEX format should work
    const validFile = path.join(testDataDir, "32014R1286.html");
    fs.writeFileSync(validFile, "<html>Valid</html>", "utf-8");
    
    try {
      const html = await fetchRegulationHtml("32014R1286");
      expect(html).toBe("<html>Valid</html>");
    } finally {
      if (fs.existsSync(validFile)) {
        fs.unlinkSync(validFile);
      }
    }
  });
});

describe("fetchRegulationHtml - existing functionality", () => {
  const testDataDir = path.resolve(__dirname, "../../data/eurlex");
  const validFile = path.join(testDataDir, "32014R1286.html");
  const validContent = "<html><body>PRIIPs regulation</body></html>";

  beforeAll(() => {
    if (!fs.existsSync(testDataDir)) {
      fs.mkdirSync(testDataDir, { recursive: true });
    }
    fs.writeFileSync(validFile, validContent, "utf-8");
  });

  afterAll(() => {
    if (fs.existsSync(validFile)) {
      fs.unlinkSync(validFile);
    }
  });

  it("reads existing regulation file", async () => {
    const html = await fetchRegulationHtml("32014R1286");
    expect(html).toBe(validContent);
  });

  it("handles non-existent file by attempting network fetch", async () => {
    // This will fail with network error or WAF challenge, but should not throw path error
    await expect(
      fetchRegulationHtml("99999R9999")
    ).rejects.toThrow();
    // Should NOT throw "Invalid file path" - it should try to fetch from network
  });
});
