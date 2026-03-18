---
name: write-a-prd
description: Create a PRD through user interview, codebase exploration, and module design, then save as a todo. Use when user wants to write a PRD, create a product requirements document, or plan a new feature.
---

Create a PRD. Skip steps if not necessary.

1. Ask the user for a detailed description of the problem and potential solutions.

2. Explore the repo to verify assertions and understand the current state.

3. Interview the user relentlessly about every aspect of this plan until reaching a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. **Skip this step if the user has already been interviewed (e.g., via grill-me) and provides the interview context.**

4. Sketch out major modules to build or modify. Look for opportunities to extract deep modules — modules that encapsulate a lot of functionality behind a simple, testable interface that rarely changes. Check with the user that these modules match expectations and which need tests.

5. Determine the next PRD number: List all existing todos with tag `prd`. Find the highest `PRD #N` number from their titles. Use N+1 for the new PRD. If no PRDs exist, start with `PRD #1`.

6. Write the PRD using the template below and save it as a todo:
   - **Title**: `PRD #N: <descriptive title>`
   - **Tags**: `prd`, `prd-N` (e.g., `prd-1`, `prd-2`)
   - **Body**: the full PRD content

7. After saving the PRD todo, ask the user if they want to break it into tasks now (skill:prd-to-todos).

<prd-template>

## Problem Statement

The problem from the user's perspective.

## Solution

The solution from the user's perspective.

## User Stories

A long, numbered list of user stories:

1. As an <actor>, I want a <feature>, so that <benefit>

Cover all aspects of the feature extensively.

## Implementation Decisions

- Modules to build/modify
- Interface changes
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include file paths or code snippets — they become outdated quickly.

## Testing Decisions

- What makes a good test (test behavior, not implementation)
- Which modules to test
- Prior art for tests in the codebase

## Out of Scope

What is explicitly not part of this PRD.

## Further Notes

Any additional context.

</prd-template>
