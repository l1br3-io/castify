---
paths:
  - "**/*.rb"
  - "**/*.rake"
  - "**/Gemfile"
  - "**/app/**/*.erb"
  - "**/config/routes.rb"
---
# Ruby Patterns

> This file extends common/patterns.md (../common/patterns.md) with Ruby and Rails specific content.

## Rails Way First

- Start with plain Rails MVC and Active Record conventions for small and medium features.
- Introduce service objects, query objects, form objects, decorators, or presenters when the model/controller boundary is carrying multiple responsibilities.
- Name extracted objects after the business operation they perform, not after generic layers like `Manager` or `Processor`.

## Persistence

- Prefer PostgreSQL for multi-host production Rails apps unless the existing platform has a clear reason for MySQL or SQLite.
- Treat Rails 8 SQLite-backed defaults as viable for single-host or modest deployments, not as an automatic fit for shared multi-service systems.
- Keep raw SQL behind query objects or model scopes and parameterize every dynamic value.

## Background Jobs And Runtime Services

- Use **Solid Queue** for greenfield Rails 8 apps with modest throughput and simple deployment needs.
- Use **Sidekiq** when the app needs mature observability, high throughput, existing Redis infrastructure, or Pro/Enterprise features.
- Use **Solid Cache** and **Solid Cable** when their deployment model matches the app; use Redis when shared cross-service behavior, high fanout, or advanced data structures matter.

## Frontend

- Prefer **Hotwire** with Turbo, Stimulus, Importmap, and Propshaft for server-rendered Rails apps.
- Use React, Vue, Inertia.js, or a separate SPA when interaction complexity, existing product architecture, or team ownership justifies the extra client surface.
- Keep view components, partials, and presenters focused on rendering decisions; keep persistence and authorization out of templates.

## Authentication

- Use the Rails 8 authentication generator for straightforward session auth and password reset needs.
- Use Devise or another established auth system when requirements include OAuth, MFA, confirmable/lockable flows, multi-model auth, or a large existing Devise footprint.

## Contract Definition

Ruby has no native interfaces; express contracts as a module + method
signatures. Use Sorbet or RBS for typed signatures; `T::Struct` or `Dry::Struct`
for DTOs:

```ruby
# Sorbet
module TaskAPI
  extend T::Sig
  sig { params(input: CreateTaskInput).returns(Task) }
  def create_task(input); end
  sig { params(id: String).returns(Task) }
  def get_task(id); end
end
```

## Error Representation

Define a single exception hierarchy rooted at a domain base; never raise raw
`StandardError` at module boundaries. Map to the universal REST envelope
(`{ code, message, details? }`) via `rescue_from` (Rails) or app middleware:

```ruby
class ApiError < StandardError; end
class ValidationError < ApiError
  attr_reader :details
  def initialize(details)
    @details = details
    super("Validation failed")
  end
end
class NotFoundError < ApiError; end
class ConflictError < ApiError; end
```

## Boundary Validation

Validate at the controller boundary (Rails Strong Parameters + ActiveModel
Validations, or Dry-validation). Internal code trusts the parsed object:

```ruby
# Dry-validation
CreateTaskSchema = Dry::Validation.Schema do
  required(:title).filled(:str?, max_size?: 200)
  optional(:description).maybe(:str?, max_size?: 2000)
end

result = CreateTaskSchema.call(params)
return render_error(422, "VALIDATION_ERROR", result.errors) if result.failure?

task = svc.create(result.to_h)
render json: task, status: 201
```

## Additive Evolution

- Add fields as optional keyword args (`def create(title:, description: nil)`)
  so existing callers don't break.
- Adding a required kwarg is breaking.
- For JSON DTOs, permit unknown keys by default; relaxing is safe, tightening
  is breaking.
- Don't rename serialized keys without an alias during a migration window.

## Variant Types

Ruby has no native sum types. Model variants as classes + `case`/`when`, or as
Dry-types sums / `T::Enum` (Sorbet):

```ruby
module TaskStatus
  class Pending; end
  InProgress = Struct.new(:assignee, :started_at)
  Completed  = Struct.new(:completed_at, :completed_by)
  Cancelled  = Struct.new(:reason, :cancelled_at)
end

def label(status)
  case status
  when TaskStatus::Pending     then "Pending"
  when TaskStatus::InProgress  then "In progress (#{status.assignee})"
  when TaskStatus::Completed   then "Done on #{status.completed_at}"
  when TaskStatus::Cancelled   then "Cancelled: #{status.reason}"
  end
end
```

## Input/Output Separation

Separate request objects (caller-provided) from response objects (with
server-generated fields). Use `T::Struct`, `Dry::Struct`, or value objects:

```ruby
class CreateTaskInput < T::Struct
  const :title, String
  const :description, T.nilable(String), default: nil
end

class Task < T::Struct
  const :id, String
  const :title, String
  const :description, T.nilable(String)
  const :created_at, Time
  const :updated_at, Time
  const :created_by, String
end
```

## Opaque IDs

Ruby doesn't enforce ID types at runtime by default; use Sorbet types or value
objects to distinguish them:

```ruby
class TaskId < T::Struct
  const :value, String
end
class UserId < T::Struct
  const :value, String
end

sig { params(id: TaskId).returns(Task) }
def get_task(id); end
```
