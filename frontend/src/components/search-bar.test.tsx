import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { createRef } from "react";

import { SearchBar } from "./search-bar";
import { renderWithProviders } from "../test/utils";

describe("SearchBar", () => {
  it("renders the provided value in the input", () => {
    renderWithProviders(<SearchBar value="concert" onChange={() => {}} />);

    const input = screen.getByLabelText("Search videos") as HTMLInputElement;
    expect(input.value).toBe("concert");
  });

  it("calls onChange when the user types", () => {
    const onChange = vi.fn();
    renderWithProviders(<SearchBar value="" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Search videos"), {
      target: { value: "hello" },
    });

    expect(onChange).toHaveBeenCalledWith("hello");
  });

  it("does not show the clear button when the input is empty", () => {
    renderWithProviders(<SearchBar value="" onChange={() => {}} />);

    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
  });

  it("shows the clear button when the input has a value", () => {
    renderWithProviders(<SearchBar value="concert" onChange={() => {}} />);

    expect(screen.getByRole("button", { name: "Clear search" })).toBeInTheDocument();
  });

  it("clears the input when the clear button is clicked", () => {
    const onChange = vi.fn();
    renderWithProviders(<SearchBar value="concert" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("forwards the ref to the input element", () => {
    const ref = createRef<HTMLInputElement>();
    renderWithProviders(<SearchBar ref={ref} value="" onChange={() => {}} />);

    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    expect(ref.current).toBe(screen.getByLabelText("Search videos"));
  });

  it("defaults label and placeholder to the library strings", () => {
    renderWithProviders(<SearchBar value="" onChange={() => {}} />);

    expect(screen.getByLabelText("Search videos")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search your library — titles, folders, subtitles…")).toBeInTheDocument();
  });

  it("flows custom label and placeholder to the input", () => {
    renderWithProviders(
      <SearchBar value="" onChange={() => {}} label="Search this share" placeholder="Find a video…" />,
    );

    expect(screen.getByLabelText("Search this share")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Find a video…")).toBeInTheDocument();
    expect(screen.queryByLabelText("Search videos")).not.toBeInTheDocument();
  });
});
