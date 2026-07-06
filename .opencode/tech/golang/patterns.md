---
paths:
  - "**/*.go"
  - "**/go.mod"
  - "**/go.sum"
---
# Go Patterns

> This file extends common/patterns.md (../common/patterns.md) with Go specific content.

## Functional Options

```go
type Option func(*Server)

func WithPort(port int) Option {
    return func(s *Server) { s.port = port }
}

func NewServer(opts ...Option) *Server {
    s := &Server{port: 8080}
    for _, opt := range opts {
        opt(s)
    }
    return s
}
```

## Small Interfaces

Define interfaces where they are used, not where they are implemented.

## Dependency Injection

Use constructor functions to inject dependencies:

```go
func NewUserService(repo UserRepository, logger Logger) *UserService {
    return &UserService{repo: repo, logger: logger}
}
```

## Contract Definition

Define interfaces where they are consumed; keep them small. Use structs for
DTOs:

```go
type TaskAPI interface {
    CreateTask(ctx context.Context, in CreateTaskInput) (Task, error)
    ListTasks(ctx context.Context, p ListTasksParams) (Paged[Task], error)
    GetTask(ctx context.Context, id string) (Task, error)
    UpdateTask(ctx context.Context, id string, in UpdateTaskInput) (Task, error)
    DeleteTask(ctx context.Context, id string) error
}

type CreateTaskInput struct {
    Title       string `json:"title"`
    Description string `json:"description,omitempty"`
}
```

## Error Representation

Implement the `error` interface; use sentinel errors + `errors.Is`/`errors.As`,
and map to the universal REST envelope (`{ code, message, details? }`) at the
handler:

```go
var (
    ErrValidation = errors.New("validation error")
    ErrNotFound   = errors.New("not found")
    ErrConflict   = errors.New("conflict")
)

type APIError struct {
    Code    string      `json:"code"`
    Message string      `json:"message"`
    Details []FieldError `json:"details,omitempty"`
}
```

## Boundary Validation

Use struct tags (`go-playground/validator`) and decode at the handler; internal
code trusts the parsed struct:

```go
type CreateTaskInput struct {
    Title       string `json:"title" validate:"required,max=200"`
    Description string `json:"description,omitempty" validate:"max=2000"`
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
    var in CreateTaskInput
    if err := decodeAndValidate(r, &in); err != nil {
        writeError(w, 422, "VALIDATION_ERROR", err)
        return
    }
    task, _ := h.svc.Create(r.Context(), in)
    writeJSON(w, 201, task)
}
```

## Additive Evolution

- Add fields with `omitempty` so old JSON still decodes cleanly and old clients
  aren't forced to send them.
- Pointer fields (`*string`, `*int`) distinguish "absent" from "zero value" —
  use them for optional-but-distinguishable inputs.
- Do NOT change a field's Go type or JSON key; do NOT remove a field others read.
- Adding a required field (non-pointer, no default) is breaking.

## Variant Types

Go has no native sum types. Model variants as a struct with a discriminator
(`Kind`) + per-variant fields, switched explicitly:

```go
type TaskStatus struct {
    Kind        string     // "pending" | "in_progress" | "completed" | "cancelled"
    Assignee    string     `json:"assignee,omitempty"`
    StartedAt   *time.Time `json:"startedAt,omitempty"`
    CompletedAt *time.Time `json:"completedAt,omitempty"`
    CompletedBy string     `json:"completedBy,omitempty"`
    Reason      string     `json:"reason,omitempty"`
}
```

## Input/Output Separation

Separate request DTOs from response DTOs:

```go
type CreateTaskInput struct {
    Title       string `json:"title"`
    Description string `json:"description,omitempty"`
}

type Task struct {
    ID          string    `json:"id"`
    Title       string    `json:"title"`
    Description string    `json:"description"`
    CreatedAt   time.Time `json:"createdAt"`
    UpdatedAt   time.Time `json:"updatedAt"`
    CreatedBy   string    `json:"createdBy"`
}
```

## Opaque IDs

Use named types so distinct IDs are not interchangeable at call sites:

```go
type TaskID string
type UserID string

func GetTask(ctx context.Context, id TaskID) (Task, error) { return Task{}, nil }
```
