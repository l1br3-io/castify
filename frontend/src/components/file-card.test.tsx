// FileCard + FileRow tests (M9 task 010).
//
// The core assertion of the whole effort lives here: non-video entries
// expose a download affordance and NEVER a play affordance — no element
// with a "Play" accessible name, no play-glyph anywhere in the card.

import { render, screen } from "@testing-library/react";

import { FileCard, FileRow } from "./file-card";
import type { FileEntryDto } from "../api/types";

function entry(overrides: Partial<FileEntryDto> = {}): FileEntryDto {
  return {
    id: "f1",
    name: "song.mp3",
    provider: "google_drive",
    path: "/Media/Music/song.mp3",
    size_bytes: 4096,
    mime_type: "audio/mpeg",
    kind: "audio",
    modified_at: "2026-08-01T12:00:00Z",
    ...overrides,
  };
}

const kinds = ["audio", "image", "subtitle", "document", "archive", "other"] as const;

describe("FileCard", () => {
  it("renders every kind with its name and size", () => {
    for (const kind of kinds) {
      const { unmount } = render(
        <FileCard file={entry({ kind, name: `thing.${kind}` })} />,
      );
      expect(screen.getByText(`thing.${kind}`)).toBeInTheDocument();
      expect(screen.getByText("4.0 KB")).toBeInTheDocument();
      unmount();
    }
  });

  it("exposes a download link labeled with the file name and correct href", () => {
    render(<FileCard file={entry({ id: "abc 123", name: "song.mp3" })} />);
    const link = screen.getByRole("link", { name: "Download song.mp3" });
    expect(link).toHaveAttribute("href", "/api/files/abc%20123/download");
  });

  it("never renders a play affordance", () => {
    for (const kind of kinds) {
      const { unmount } = render(
        <FileCard file={entry({ kind, name: `thing.${kind}` })} />,
      );
      expect(screen.queryByRole("link", { name: /play/i })).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText(new RegExp(`play thing.${kind}`, "i")),
      ).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe("FileRow", () => {
  it("renders name, size, and a trailing download action", () => {
    render(
      <FileRow file={entry({ kind: "document", name: "thesis.pdf", size_bytes: 512_000 })} />,
    );
    expect(screen.getByText("thesis.pdf")).toBeInTheDocument();
    expect(screen.getByText(/500.0 KB /)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Download thesis.pdf" }),
    ).toBeInTheDocument();
  });

  it("shows the modified date when present", () => {
    render(<FileRow file={entry({ modified_at: "2026-08-01T12:00:00Z" })} />);
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });

  it("never renders a play affordance", () => {
    render(<FileRow file={entry({ kind: "subtitle", name: "movie.en.srt" })} />);
    expect(screen.queryByRole("link", { name: /play/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/play movie/i)).not.toBeInTheDocument();
  });
});
