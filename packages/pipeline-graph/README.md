# @pipewright/pipeline-graph

A pipeline as a process model. `toModel` maps a `Pipeline` to the `Model` of [`process-graph`](https://www.npmjs.com/package/process-graph), so the swimlane, flowchart and state projections and the readiness, blocking and critical-path queries of `process-graph` apply to it. `overlayOf` maps platform run state to the schema's `Overlay`, so those queries can answer for one run.

```ts
import { toModel, overlayOf } from "@pipewright/pipeline-graph";
import { readySet, toSwimlane } from "process-graph";

const model = toModel(pipeline);
toSwimlane(model).lanes; // one lane per runner
readySet(model, overlayOf(runState), facts); // what can start now
```

Element ids are job ids, so run state keyed by job id lines up with the model without translation.

## `toModel`

| Pipeline                 | Model                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| a job                    | an `activity` with the job id as its id and the job name as its label                                             |
| a job's `runsOn` labels  | one `system` participant per distinct label list, id `runner:` followed by the labels joined with a comma, the activity's `actor`     |
| a `needs` entry          | a transition from the needed job to the dependent job                                                             |
| a job with `when`        | a `decision` (`<job>:when`) before the job; its only outgoing transition carries the predicate as its `condition` |
| a matrix job             | the activity between a `fork` (`<job>:fork`) and a `join` (`<job>:join`) pseudo-state                             |
| a job without `needs`    | a transition from the `initial` pseudo-state (`pipeline:initial`)                                                 |
| a job that nothing needs | a transition to the `final` pseudo-state (`pipeline:final`)                                                       |

A job id never contains a colon, so the generated ids cannot collide with a job.

`needs` enter a job's decision when it has one, else its fork when it is a matrix job, else the activity. Dependents leave from the join when the needed job is a matrix job, else from the activity. Every transition id is `<source>-><target>`.

The `when` predicate is the trilean `PredicateNode` the model's `condition` uses, so it is carried over unchanged and its references are the pipeline's own context keys and matrix axes. When the predicate is definitely false, the domain package cuts the transition: the job is `skipped`, and so is every job that depends only on skipped jobs. When facts cannot answer it, the job is `unknown`.

### Matrix jobs

A matrix job stays one activity between a `fork` and a `join`. The model has no repetition by value, so expanding the combinations would need one element per combination with ids no run state is keyed by, and would make the model's shape depend on axis values. The pair states what matters to the process: the work fans out and every combination must complete before dependents continue. A run reports a matrix job as the aggregate of its combinations.

### Not carried

The steps, `needsPolicy`, permissions, environment, timeouts and provider-native mappings. The model describes ordering and ownership; a job that runs whatever its needs concluded (`needsPolicy: "always"`) is still ordered after them.

## `overlayOf`

Run state is `Record<jobId, JobState>`, where a `JobState` is either `{ kind: "reported", check }` with a `Check` from `@pipewright/platform-contract`, or `{ kind: "unresolved" }` for a job the platform could not report on. Matching checks to job ids is the reader's work: a check's name is provider-specific, and `check-names` derives them.

| Run state for the job                                                         | Overlay entry                                      |
| ----------------------------------------------------------------------------- | -------------------------------------------------- |
| no entry                                                                      | no entry, which the domain package reads as `open` |
| `unresolved`                                                                  | `unknown`                                          |
| check `queued`, `running` or `waiting`                                        | `open`                                             |
| check `completed` with `success`, `neutral` or `skipped`                      | `done`                                             |
| check `completed` with `failure`, `timedOut`, `cancelled` or `actionRequired` | `open`                                             |
| check `completed` with `stale`                                                | `unknown`                                          |

`neutral` and `skipped` count as done because they satisfy a required check on the platform and leave nothing to run. A failed, timed-out, cancelled or approval-blocked job is not finished, so it stays open and what needs it stays blocked. `stale` describes an earlier commit, so it says nothing about this one.

Only activities get entries. The decision, fork, join, initial and final elements are control elements, and the domain package derives their state from the activities around them.
