// FolderNameDialog — the shared create/rename name prompt
// (library-folders task 008), extracted verbatim from share-manage.tsx
// where it was born: trimmed-name submit, whitespace guard, pending
// freeze, server error surfaced under the field. One component, two
// consumers (share manage page and the library organizer).

import { useState, type FormEvent } from "react";

import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Field, Input } from "./ui/field";

export function FolderNameDialog({
  title,
  initialName,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  initialName: string;
  pending: boolean;
  error?: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    if (trimmed === "" || pending) return;
    onSubmit(trimmed);
  }

  return (
    <Dialog open onClose={onClose} closeable={!pending} title={title}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field
          label="Folder name"
          error={trimmed === "" && name !== "" ? "Name can't be only whitespace." : error}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={trimmed === ""} pending={pending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
