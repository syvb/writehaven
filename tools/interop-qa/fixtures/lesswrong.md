# A Small Replication

I tried to **replicate** the claim, and it *mostly* held.[1] Details follow.

> A claim nobody checks is only a rumour with good manners.

## Method

1. Pick a claim.
2. Find the original source.
   - Not the press release.
3. Check the numbers.

The key quantity was `p < 0.05`, which is [not what you think](https://www.lesswrong.com/tag/p-values).

| Study | Effect size |
| --- | --- |
| Original | 0.8 |
| Replication | 0.1 |

```python
def check(claim):
    return claim.source is not None
```

---

[image: A scatter plot of effect sizes](https://res.cloudinary.com/lesswrong-2-0/image/upload/v1/mirroredImages/abc123.png)

Effect sizes shrink on replication.

>! The answer is 42.

1. Mostly meaning: in two of three samples.
