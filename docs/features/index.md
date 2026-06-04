---
title: 功能
aside: false
head:
  - - meta
    - http-equiv: refresh
      content: 0;url=./search
---

<script setup>
import { onMounted } from 'vue'
import { useRouter, withBase } from 'vitepress'

const router = useRouter()
onMounted(() => router.go(withBase('/features/search')))
</script>

# 功能

正在前往[全文搜索](/features/search)…
