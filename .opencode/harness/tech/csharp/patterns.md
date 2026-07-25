---
paths:
  - "**/*.cs"
  - "**/*.csx"
---
# C# Patterns

> This file extends common/patterns.md (../common/patterns.md) with C#-specific content.

## API Response Pattern

```csharp
public sealed record ApiResponse<T>(
    bool Success,
    T? Data = default,
    string? Error = null,
    object? Meta = null);
```

## Repository Pattern

```csharp
public interface IRepository<T>
{
    Task<IReadOnlyList<T>> FindAllAsync(CancellationToken cancellationToken);
    Task<T?> FindByIdAsync(Guid id, CancellationToken cancellationToken);
    Task<T> CreateAsync(T entity, CancellationToken cancellationToken);
    Task<T> UpdateAsync(T entity, CancellationToken cancellationToken);
    Task DeleteAsync(Guid id, CancellationToken cancellationToken);
}
```

## Options Pattern

Use strongly typed options for config instead of reading raw strings throughout the codebase.

```csharp
public sealed class PaymentsOptions
{
    public const string SectionName = "Payments";
    public required string BaseUrl { get; init; }
    public required string ApiKeySecretName { get; init; }
}
```

## Dependency Injection

- Depend on interfaces at service boundaries
- Keep constructors focused; if a service needs too many dependencies, split responsibilities
- Register lifetimes intentionally: singleton for stateless/shared services, scoped for request data, transient for lightweight pure workers

## Contract Definition

Use `interface` for contracts and `record` for DTOs:

```csharp
public interface ITaskApi
{
    Task<Task> CreateTaskAsync(CreateTaskInput input, CancellationToken ct = default);
    Task<Paged<Task>> ListTasksAsync(ListTasksParams p, CancellationToken ct = default);
    Task<Task> GetTaskAsync(string id, CancellationToken ct = default);
    Task<Task> UpdateTaskAsync(string id, UpdateTaskInput input, CancellationToken ct = default);
    Task DeleteTaskAsync(string id, CancellationToken ct = default);
}

public record CreateTaskInput(string Title, string? Description = null);

public record Task(
    string Id,
    string Title,
    string? Description,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    string CreatedBy);
```

## Error Representation

Use a single exception hierarchy (or a `Result<T, TError>` for expected
failures). Map to the universal REST envelope (`{ code, message, details? }`)
via an exception middleware / `IExceptionHandler`. Do not mix throwing and
returning `null`/result types for the same operation:

```csharp
public abstract class ApiException : Exception
{
    public abstract string Code { get; }
    protected ApiException(string message) : base(message) { }
}

public sealed class ValidationException : ApiException
{
    public override string Code => "VALIDATION_ERROR";
    public IReadOnlyList<FieldError> Details { get; }
    public ValidationException(IReadOnlyList<FieldError> details) : base("Validation failed")
        => Details = details;
}
```

## Boundary Validation

Use FluentValidation or DataAnnotations at the controller boundary; trust types
internally:

```csharp
public sealed class CreateTaskInputValidator : AbstractValidator<CreateTaskInput>
{
    public CreateTaskInputValidator()
    {
        RuleFor(x => x.Title).NotEmpty().MaximumLength(200);
        RuleFor(x => x.Description).MaximumLength(2000);
    }
}
```

## Additive Evolution

- Add new `record` parameters with defaults so positional callers still compile.
- Removing or reordering positional parameters is breaking.
- For JSON, configure `JsonSerializerOptions` to ignore unknown properties
  (default) so new server fields don't break old clients.
- `string` → `string?` is breaking for consumers with nullable reference types
  enabled; add as new optional fields or via `?` from the start.
- Mark removals `[Obsolete("...", error: false)]` before deletion.

## Variant Types

Use a sealed class hierarchy + records (exhaustive pattern matching), or a
`OneOf`/`Result` library:

```csharp
public abstract record TaskStatus
{
    public sealed record Pending : TaskStatus;
    public sealed record InProgress(string Assignee, DateTimeOffset StartedAt) : TaskStatus;
    public sealed record Completed(DateTimeOffset CompletedAt, string CompletedBy) : TaskStatus;
    public sealed record Cancelled(string Reason, DateTimeOffset CancelledAt) : TaskStatus;
}

public string Label(TaskStatus s) => s switch
{
    TaskStatus.Pending    => "Pending",
    TaskStatus.InProgress i => $"In progress ({i.Assignee})",
    TaskStatus.Completed  c => $"Done on {c.CompletedAt}",
    TaskStatus.Cancelled  x => $"Cancelled: {x.Reason}",
};
```

## Input/Output Separation

Separate request records (caller-provided) from response records
(server-generated fields included). See `CreateTaskInput` vs `Task` in Contract
Definition above.

## Opaque IDs

Use `record` or `readonly struct` wrappers so distinct IDs are not
interchangeable:

```csharp
public readonly record struct TaskId(string Value);
public readonly record struct UserId(string Value);

Task<Task> GetTaskAsync(TaskId id, CancellationToken ct = default);
```
