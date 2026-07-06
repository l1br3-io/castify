---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Python Patterns

> This file extends common/patterns.md (../common/patterns.md) with Python specific content.

## Protocol (Duck Typing)

```python
from typing import Protocol

class Repository(Protocol):
    def find_by_id(self, id: str) -> dict | None: ...
    def save(self, entity: dict) -> dict: ...
```

## Dataclasses as DTOs

```python
from dataclasses import dataclass

@dataclass
class CreateUserRequest:
    name: str
    email: str
    age: int | None = None
```

## Context Managers & Generators

- Use context managers (`with` statement) for resource management
- Use generators for lazy evaluation and memory-efficient iteration

## Contract Definition

Use `Protocol` (structural) or `abc.ABC` (nominal) for contracts; `dataclass`
or `pydantic.BaseModel` for DTOs:

```python
from typing import Protocol

class TaskAPI(Protocol):
    async def create_task(self, input: CreateTaskInput) -> Task: ...
    async def list_tasks(self, params: ListTasksParams) -> Paged[Task]: ...
    async def get_task(self, id: str) -> Task: ...
    async def update_task(self, id: str, input: UpdateTaskInput) -> Task: ...
    async def delete_task(self, id: str) -> None: ...
```

## Error Representation

Define a single exception hierarchy rooted at a domain base; never raise raw
built-ins at module boundaries. Map to the universal REST envelope
(`{ code, message, details? }`) in the framework's exception handler:

```python
class ApiError(Exception):
    code: str = "INTERNAL_ERROR"

class ValidationError(ApiError):
    code = "VALIDATION_ERROR"
    def __init__(self, details: list[FieldError]):
        self.details = details

class NotFoundError(ApiError):
    code = "NOT_FOUND"

class ConflictError(ApiError):
    code = "CONFLICT"
```

## Boundary Validation

Validate at the request/response boundary with pydantic; internal code trusts
the parsed model:

```python
from pydantic import BaseModel, Field

class CreateTaskInput(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = None

@router.post("/tasks", status_code=201)
async def create(input: CreateTaskInput) -> Task:
    return await svc.create(input)
```

## Additive Evolution

- New fields must have a default (`x: str | None = None`) so old clients still
  validate.
- `x: str` (no default) is required — adding one is breaking.
- pydantic default `extra="ignore"` is forward-compatible; `extra="forbid"`
  rejects unknown keys and is stricter.
- Widening `str` to `str | None` is breaking for consumers that assume str.

## Variant Types

Use `Literal` for simple tags, discriminated unions for variants with payloads
(pydantic supports `Field(discriminator=...)`):

```python
from typing import Annotated, Literal, Union
from pydantic import BaseModel, Field

class Pending(BaseModel):
    type: Literal["pending"]

class InProgress(BaseModel):
    type: Literal["in_progress"]
    assignee: str
    started_at: datetime

class Completed(BaseModel):
    type: Literal["completed"]
    completed_at: datetime
    completed_by: str

class Cancelled(BaseModel):
    type: Literal["cancelled"]
    reason: str
    cancelled_at: datetime

TaskStatus = Annotated[
    Union[Pending, InProgress, Completed, Cancelled],
    Field(discriminator="type"),
]
```

## Input/Output Separation

Separate request models from response models:

```python
class CreateTaskInput(BaseModel):
    title: str
    description: str | None = None

class Task(BaseModel):
    id: str
    title: str
    description: str | None
    created_at: datetime
    updated_at: datetime
    created_by: str
```

## Opaque IDs

Use `NewType` to prevent cross-ID mixups at the type-checker level:

```python
from typing import NewType

TaskId = NewType("TaskId", str)
UserId = NewType("UserId", str)

async def get_task(id: TaskId) -> Task: ...
```
