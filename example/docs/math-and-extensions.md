# Math and Extension Coverage

This page exercises Markdown math and Supramark extension fallback behavior.

## Inline Math

Inline KaTeX target: energy is $E = mc^2$ and the circle area is $A = \pi r^2$.

## Display Math

KaTeX display math target:

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$

## Matrix Math

Matrix math target:

$$
\begin{bmatrix}
1 & 2 \\
3 & 4
\end{bmatrix}
\begin{bmatrix}
x \\
y
\end{bmatrix}
=
\begin{bmatrix}
1x + 2y \\
3x + 4y
\end{bmatrix}
$$

## Aligned Equations

Aligned math target:

$$
\begin{aligned}
f(x) &= x^2 + 2x + 1 \\
     &= (x + 1)^2
\end{aligned}
$$

## Nested Math In Lists

- List item with inline math: $a^2 + b^2 = c^2$.
- List item followed by display math:

  $$
  \int_0^1 x^2 dx = \frac{1}{3}
  $$

## Nested Math In Blockquote

> Blockquote inline math target: $\alpha + \beta = \gamma$.
>
> $$
> \lim_{x \to 0} \frac{\sin x}{x} = 1
> $$

## Unsupported Extension Fallback: Map

This block is intentionally unsupported in Markon today. It should render as a labeled source fallback, not as an unlabeled code block.

:::map
center: [37.7749, -122.4194]
zoom: 12
marker:
  lat: 37.7749
  lng: -122.4194
  label: Markon fixture
:::

## Unsupported Extension Fallback: Form

This input extension is also intentionally rendered as labeled source fallback.

%%%form review
name: Reviewer
decision: pending
%%%

