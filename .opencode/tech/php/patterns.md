---
paths:
  - "**/*.php"
  - "**/composer.json"
---
# PHP Patterns

> This file extends common/patterns.md (../common/patterns.md) with PHP specific content.

## Thin Controllers, Explicit Services

- Keep controllers focused on transport: auth, validation, serialization, status codes.
- Move business rules into application/domain services that are easy to test without HTTP bootstrapping.

## DTOs and Value Objects

- Replace shape-heavy associative arrays with DTOs for requests, commands, and external API payloads.
- Use value objects for money, identifiers, date ranges, and other constrained concepts.

## Dependency Injection

- Depend on interfaces or narrow service contracts, not framework globals.
- Pass collaborators through constructors so services are testable without service-locator lookups.

## Boundaries

- Isolate ORM models from domain decisions when the model layer is doing more than persistence.
- Wrap third-party SDKs behind small adapters so the rest of the codebase depends on your contract, not theirs.

## Contract Definition

Use `interface` for contracts and readonly DTO classes (PHP 8.2+ `readonly
class`) for DTOs:

```php
interface TaskApi
{
    public function createTask(CreateTaskInput $input): Task;
    public function listTasks(ListTasksParams $params): Paged;
    public function getTask(string $id): Task;
    public function updateTask(string $id, UpdateTaskInput $input): Task;
    public function deleteTask(string $id): void;
}

final readonly class CreateTaskInput
{
    public function __construct(
        public string $title,
        public ?string $description = null,
    ) {}
}
```

## Error Representation

Use a single exception hierarchy rooted at a domain base; map to the universal
REST envelope (`{ code, message, details? }`) via a global handler / middleware:

```php
class ApiException extends RuntimeException {}
class ValidationException extends ApiException
{
    public function __construct(public array $details)
    {
        parent::__construct('Validation failed');
    }
}
class NotFoundException extends ApiException {}
class ConflictException extends ApiException {}
```

## Boundary Validation

Validate at the controller boundary (Symfony Validator, Laravel Form Requests,
or respect/Validation). Internal code trusts the validated object:

```php
// Laravel Form Request
final class CreateTaskRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'title'       => ['required', 'string', 'max:200'],
            'description' => ['nullable', 'string', 'max:2000'],
        ];
    }
}

public function create(CreateTaskRequest $request): JsonResponse
{
    $task = $svc->create($request->validated());
    return response()->json($task, 201);
}
```

## Additive Evolution

- Add DTO constructor params with a default so existing callers compile.
- Adding a required (non-nullable, no default) constructor param is breaking.
- For JSON DTOs, Symfony Serializer / Laravel ignore unknown keys by default;
  keep that behavior for forward compatibility.
- PHP enums are closed — adding a case is safe for producers but consumers with
  exhaustive `match` may need updating (a deliberate safety signal).
- Mark removals with `@deprecated` before deletion.

## Variant Types

Use `enum` (PHP 8.1+) for pure tags; backed enums for serialization. For
variants carrying payloads, use a class per case + `match` (no native sum types):

```php
interface TaskStatus {}

final readonly class InProgress implements TaskStatus
{
    public function __construct(public string $assignee, public DateTimeImmutable $startedAt) {}
}
final readonly class Completed implements TaskStatus
{
    public function __construct(public DateTimeImmutable $completedAt, public string $completedBy) {}
}
final readonly class Cancelled implements TaskStatus
{
    public function __construct(public string $reason, public DateTimeImmutable $cancelledAt) {}
}
final class Pending implements TaskStatus {}

function label(TaskStatus $s): string
{
    return match (true) {
        $s instanceof Pending     => 'Pending',
        $s instanceof InProgress  => "In progress ({$s->assignee})",
        $s instanceof Completed   => "Done on {$s->completedAt->format('c')}",
        $s instanceof Cancelled   => "Cancelled: {$s->reason}",
    };
}
```

## Input/Output Separation

Separate request DTOs (caller-provided) from response DTOs (with server-generated
fields included). See `CreateTaskInput` vs `Task` above.

## Opaque IDs

Wrap IDs in readonly classes (or use Psalm/PHPStan type aliases) so distinct IDs
are not interchangeable under static analysis:

```php
final readonly class TaskId
{
    public function __construct(public string $value) {}
}
final readonly class UserId
{
    public function __construct(public string $value) {}
}

public function getTask(TaskId $id): Task {}
```
