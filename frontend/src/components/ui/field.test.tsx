// Field + Input — label/id wiring and error announcement contract
// (ui/README.md § Field): the input is described by hint/error text via
// aria-describedby and flagged with aria-invalid when an error is shown.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Field, Input } from "./field";

describe("Field", () => {
  it("wires the label to the input id automatically", () => {
    render(
      <Field label="Password">
        <Input type="password" />
      </Field>,
    );
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
  });

  it("announces errors: described-by the error text and aria-invalid", () => {
    render(
      <Field label="Password" error="Password must be at least 8 characters.">
        <Input type="password" />
      </Field>,
    );
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    const errorText = screen.getByText("Password must be at least 8 characters.");
    expect(errorText.id).toBeTruthy();
    expect(describedBy).toContain(errorText.id);
  });

  it("links hint text through aria-describedby too", () => {
    render(
      <Field label="Share name" hint="Shown to people with the link.">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText("Share name");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(describedBy).toContain(
      screen.getByText("Shown to people with the link.").id,
    );
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("describes the input with hint and error together, error last", () => {
    render(
      <Field
        label="Share name"
        hint="Shown to people with the link."
        error="Name is required."
      >
        <Input />
      </Field>,
    );
    const describedBy =
      screen.getByLabelText("Share name").getAttribute("aria-describedby") ?? "";
    const ids = describedBy.split(" ");
    expect(ids).toHaveLength(2);
    expect(ids.indexOf(screen.getByText("Name is required.").id)).toBeGreaterThan(
      ids.indexOf(screen.getByText("Shown to people with the link.").id),
    );
  });

  it("renders error text in the danger token color", () => {
    render(
      <Field label="Share name" error="Name is required.">
        <Input />
      </Field>,
    );
    expect(screen.getByText("Name is required.").className).toContain(
      "text-[var(--color-danger)]",
    );
  });

  it("supports typing (controlled input passes through)", () => {
    const onChange = vi.fn();
    render(
      <Field label="Name">
        <Input value="" onChange={onChange} />
      </Field>,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "a" } });
    expect(onChange).toHaveBeenCalledOnce();
  });
});

describe("Input outside a Field", () => {
  it("renders standalone without aria wiring", () => {
    render(<Input aria-label="Standalone" />);
    const input = screen.getByLabelText("Standalone");
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("keeps Field-owned ids stable across renders", () => {
    const { rerender } = render(
      <Field label="Name">
        <Input />
      </Field>,
    );
    const before = screen.getByLabelText("Name").id;
    rerender(
      <Field label="Name">
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText("Name").id).toBe(before);
  });
});
