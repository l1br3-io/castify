// UploadVeil tests (drag-and-drop task 012) — the OS-file veil reacts
// only to native drags that carry Files; internal pointer drags and
// text drags never trigger it; a drop hands the files over and hides
// it again. DragEvents are synthesized with a dataTransfer stub
// (jsdom's DragEvent carries none).

import { describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";

import { UploadVeil } from "./upload-veil";
import { renderWithProviders } from "../test/utils";

function dragEvent(type: string, types: string[], files: File[] = []): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types, files },
  });
  return event;
}

/** Dispatch inside act — the listener flips React state. */
function fire(event: Event): void {
  act(() => {
    window.dispatchEvent(event);
  });
}

const FILE = new File([new Uint8Array(4)], "clip.mp4", { type: "video/mp4" });

function renderVeil(onFiles = vi.fn()) {
  renderWithProviders(<UploadVeil onFiles={onFiles} />);
  return onFiles;
}

describe("UploadVeil", () => {
  it("shows on dragenter with files, hides on dragleave", () => {
    const onFiles = renderVeil();
    fire(dragEvent("dragenter", ["Files"]));
    expect(screen.getByTestId("upload-veil")).toBeInTheDocument();

    fire(dragEvent("dragleave", ["Files"]));
    expect(screen.queryByTestId("upload-veil")).not.toBeInTheDocument();
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("ignores drags that carry no files (internal pointer drags)", () => {
    renderVeil();
    fire(dragEvent("dragenter", ["text/plain"]));
    expect(screen.queryByTestId("upload-veil")).not.toBeInTheDocument();
  });

  it("stays visible across nested enter/leave pairs (depth counting)", () => {
    renderVeil();
    fire(dragEvent("dragenter", ["Files"]));
    fire(dragEvent("dragenter", ["Files"]));
    fire(dragEvent("dragleave", ["Files"]));
    expect(screen.getByTestId("upload-veil")).toBeInTheDocument();
    fire(dragEvent("dragleave", ["Files"]));
    expect(screen.queryByTestId("upload-veil")).not.toBeInTheDocument();
  });

  it("a drop hands the files over, prevents default, and hides", () => {
    const onFiles = renderVeil();
    fire(dragEvent("dragenter", ["Files"]));
    fire(dragEvent("drop", ["Files"], [FILE]));

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles).toHaveBeenCalledWith([FILE]);
    expect(screen.queryByTestId("upload-veil")).not.toBeInTheDocument();
  });

  it("renders the mono eyebrow copy", () => {
    renderVeil();
    fire(dragEvent("dragenter", ["Files"]));
    expect(screen.getByText("DROP TO UPLOAD")).toBeInTheDocument();
    expect(screen.getByText("Choose a destination after you drop.")).toBeInTheDocument();
  });
});
