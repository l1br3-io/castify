import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { useQueue } from "./use-queue";

// --- Harness: renders the queue state + buttons that call the navigation
//     hooks. Mirrors how `routes/watch.tsx` consumes `useQueue`. ---
function Harness() {
  const q = useQueue();
  return (
    <div>
      <ul data-testid="state">
        <li data-testid="queue">{q.queue.join(",")}</li>
        <li data-testid="index">{q.currentIndex}</li>
        <li data-testid="hasQueue">{String(q.hasQueue)}</li>
        <li data-testid="hasPrev">{String(q.hasPrev)}</li>
        <li data-testid="hasNext">{String(q.hasNext)}</li>
      </ul>
      <button type="button" onClick={q.goToPrev} data-testid="prev">
        Prev
      </button>
      <button type="button" onClick={q.goToNext} data-testid="next">
        Next
      </button>
      <button
        type="button"
        onClick={() => q.goToIndex(0)}
        data-testid="goto-first"
      >
        First
      </button>
    </div>
  );
}

function renderAt(
  pathname: string,
  state: unknown = undefined,
): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[state ? { pathname, state } : pathname]}>
      <Routes>
        <Route path="/watch/:id" element={<Harness />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("useQueue", () => {
  it("returns empty queue when router state is absent (direct URL / reload)", () => {
    renderAt("/watch/v2");
    expect(screen.getByTestId("queue").textContent).toBe("");
    expect(screen.getByTestId("index").textContent).toBe("-1");
    expect(screen.getByTestId("hasQueue").textContent).toBe("false");
    expect(screen.getByTestId("hasPrev").textContent).toBe("false");
    expect(screen.getByTestId("hasNext").textContent).toBe("false");
  });

  it("returns empty queue when state.queue is missing", () => {
    renderAt("/watch/v2", { other: "data" });
    expect(screen.getByTestId("queue").textContent).toBe("");
    expect(screen.getByTestId("hasQueue").textContent).toBe("false");
  });

  it("parses queue from router state and locates the current id", () => {
    renderAt("/watch/v2", { queue: ["v1", "v2", "v3"] });
    expect(screen.getByTestId("queue").textContent).toBe("v1,v2,v3");
    expect(screen.getByTestId("index").textContent).toBe("1");
    expect(screen.getByTestId("hasQueue").textContent).toBe("true");
    expect(screen.getByTestId("hasPrev").textContent).toBe("true");
    expect(screen.getByTestId("hasNext").textContent).toBe("true");
  });

  it("hasPrev is false at the queue head", () => {
    renderAt("/watch/v1", { queue: ["v1", "v2", "v3"] });
    expect(screen.getByTestId("hasPrev").textContent).toBe("false");
    expect(screen.getByTestId("hasNext").textContent).toBe("true");
  });

  it("hasNext is false at the queue tail", () => {
    renderAt("/watch/v3", { queue: ["v1", "v2", "v3"] });
    expect(screen.getByTestId("hasPrev").textContent).toBe("true");
    expect(screen.getByTestId("hasNext").textContent).toBe("false");
  });

  it("hasQueue is false when the current id is not in the queue", () => {
    renderAt("/watch/other", { queue: ["v1", "v2", "v3"] });
    expect(screen.getByTestId("hasQueue").textContent).toBe("false");
    expect(screen.getByTestId("hasPrev").textContent).toBe("false");
    expect(screen.getByTestId("hasNext").textContent).toBe("false");
  });

  it("goToNext at the tail is a no-op (stays at currentIndex)", () => {
    renderAt("/watch/v3", { queue: ["v1", "v2", "v3"] });
    fireEvent.click(screen.getByTestId("next"));
    // Hook re-runs under the same route — index unchanged.
    expect(screen.getByTestId("index").textContent).toBe("2");
  });

  it("goToPrev at the head is a no-op", () => {
    renderAt("/watch/v1", { queue: ["v1", "v2", "v3"] });
    fireEvent.click(screen.getByTestId("prev"));
    expect(screen.getByTestId("index").textContent).toBe("0");
  });

  it("goToNext navigates to the next entry, preserving the queue in state", () => {
    renderAt("/watch/v1", { queue: ["v1", "v2", "v3"] });
    fireEvent.click(screen.getByTestId("next"));
    // After navigation, `:id` is `v2` (index 1) and the queue is preserved.
    expect(screen.getByTestId("queue").textContent).toBe("v1,v2,v3");
    expect(screen.getByTestId("index").textContent).toBe("1");
  });

  it("goToPrev navigates backward within the queue", () => {
    renderAt("/watch/v3", { queue: ["v1", "v2", "v3"] });
    fireEvent.click(screen.getByTestId("prev"));
    expect(screen.getByTestId("index").textContent).toBe("1");
    expect(screen.getByTestId("queue").textContent).toBe("v1,v2,v3");
  });

  it("queue survives multiple forward + back navigations", () => {
    renderAt("/watch/v1", { queue: ["v1", "v2", "v3"] });
    fireEvent.click(screen.getByTestId("next"));
    expect(screen.getByTestId("index").textContent).toBe("1");
    fireEvent.click(screen.getByTestId("next"));
    expect(screen.getByTestId("index").textContent).toBe("2");
    fireEvent.click(screen.getByTestId("prev"));
    expect(screen.getByTestId("index").textContent).toBe("1");
  });

  it("goToIndex jumps to an arbitrary queue position", () => {
    renderAt("/watch/v3", { queue: ["v1", "v2", "v3"] });
    fireEvent.click(screen.getByTestId("goto-first"));
    expect(screen.getByTestId("index").textContent).toBe("0");
  });

  it("goToIndex is a no-op when targeting the current id", () => {
    renderAt("/watch/v2", { queue: ["v1", "v2", "v3"] });
    fireEvent.click(screen.getByTestId("goto-first"));
    // Now at v1; clicking goto-first again should be a no-op (same id).
    expect(screen.getByTestId("index").textContent).toBe("0");
    fireEvent.click(screen.getByTestId("goto-first"));
    expect(screen.getByTestId("index").textContent).toBe("0");
  });

  it("filters out non-string entries defensively", () => {
    renderAt("/watch/v1", {
      queue: ["v1", 123, null, "v2", undefined, "v3"],
    });
    expect(screen.getByTestId("queue").textContent).toBe("v1,v2,v3");
  });
});
