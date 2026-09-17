import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { NotFoundPage } from "./not-found";

describe("NotFoundPage", () => {
  it("renders an EmptyState card with a Go to library action that navigates home", () => {
    render(
      <MemoryRouter initialEntries={["/anywhere"]}>
        <Routes>
          <Route path="/anywhere" element={<NotFoundPage />} />
          <Route path="/" element={<div data-testid="home">Home</div>} />
        </Routes>
      </MemoryRouter>,
    );

    // EmptyState treatment: "404" stays as the marker, copy names the fix.
    expect(screen.getByText("404")).toBeInTheDocument();
    expect(
      screen.getByText("This page doesn't exist. The link may be old or mistyped."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /go to library/i }));
    expect(screen.getByTestId("home")).toBeInTheDocument();
  });
});
