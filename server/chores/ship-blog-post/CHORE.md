---
chore: ship-blog-post
description: Research a topic, draft a post, then editorially review it before publishing
trigger: mention
inputs: [topic]
binding: plan-time
approval: cast
min_confidence: 0.6
---

### 1. Research
needs:   web research, source gathering
do:      Gather 5–8 credible sources on {topic}; extract the key claims with citations.
returns: a sourced research brief — bullet claims, each with its URL

### 2. Draft
needs:   long-form writing, content writing
do:      Write an 800–1200 word post on {topic} from the research brief.
returns: a markdown draft with a title and section headers
after:   [1]

### 3. Review
needs:   editorial review, copy editing
do:      Check the draft against the research brief for accuracy and clarity; fix or flag issues.
returns: the final, polished post ready to publish
after:   [2]
