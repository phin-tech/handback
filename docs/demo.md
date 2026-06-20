---
title: Demo
---

<script setup>
import { onMounted } from 'vue'
import { useData } from 'vitepress'

const { site } = useData()

onMounted(() => {
  window.location.replace(site.value.base + 'demo.html')
})
</script>

Opening demo…
