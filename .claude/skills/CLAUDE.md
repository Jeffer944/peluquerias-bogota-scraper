# Assistant N8N — Guía de Claude

## Propósito del Proyecto

Este proyecto usa Claude Code para construir workflows de alta calidad en una instancia **n8n self-hosted**.
Claude trabaja junto con el servidor MCP de n8n y un conjunto de skills especializados para crear,
validar y desplegar automatizaciones directamente en n8n.

---

## Herramientas Disponibles

### 1. n8n-MCP (Servidor MCP)
- **Repositorio**: https://github.com/czlonkowski/n8n-mcp
- **Instalación**: `npx -y n8n-mcp` (configurado en `.mcp.json`)
- **Qué hace**:
  - Accede a documentación de 1,084 nodos de n8n (537 core + 547 community)
  - Consulta 2,709 templates de workflows
  - Valida configuraciones de nodos
  - Crea, actualiza y ejecuta workflows en tu instancia n8n via API

### 2. n8n-Skills (Skills de Claude Code)
- **Repositorio**: https://github.com/czlonkowski/n8n-skills
- **Instalación**: `/plugin install czlonkowski/n8n-skills`
- **Skills incluidos** (se activan automáticamente según el contexto):
  | Skill | Cuándo se activa |
  |---|---|
  | Expression Syntax | Expresiones n8n (`{{ }}`, `$json`, `$node`) |
  | MCP Tools Expert | Uso de herramientas n8n-mcp |
  | Workflow Patterns | Diseño de arquitectura de workflows |
  | Validation Expert | Interpretación de errores de validación |
  | Node Configuration | Configuración específica por operación |
  | Code JavaScript | Nodos Code con JavaScript |
  | Code Python | Nodos Code con Python |

---

## Configuración MCP (`.mcp.json`)

El archivo `.mcp.json` en la raíz del proyecto contiene la configuración del servidor n8n-mcp via npx.
Las credenciales están configuradas y listas para usar.

---

## Credenciales

- **N8N_API_URL**: https://proyect-one-n8n.utrjgo.easypanel.host
- **N8N_API_KEY**: Configurada en `.mcp.json` (no exponer en código)

Para obtener una nueva API Key: n8n → Settings → API → Create API Key

---

## Reglas de Comportamiento

### Idioma
- Responder **siempre en español** en este proyecto.
- Nombres de nodos, propiedades y código van en inglés (convención de n8n).

### Seguridad de Workflows
- **Nunca editar workflows de producción directamente** — siempre crear una copia, testear y luego reemplazar.
- Validar la configuración de nodos con n8n-mcp antes de desplegar.
- Usar el modo de ejecución manual para testear antes de activar triggers.

### Code Nodes
- Usar **JavaScript** por defecto (no Python) — mayor compatibilidad con la plataforma.
- Formato correcto de retorno:
  ```javascript
  return [{ json: { resultado: "valor" } }];
  ```
- Para múltiples ítems:
  ```javascript
  return items.map(item => ({ json: { ...item.json, campo: "nuevo" } }));
  ```
- Python **no puede** usar librerías externas (pandas, requests, etc.).

### Expresiones n8n
- Datos de webhooks: `{{ $json.body.campo }}` (no `{{ $json.campo }}` directamente)
- Nodo anterior: `{{ $json.campo }}`
- Nodo específico: `{{ $node["NombreNodo"].json.campo }}`
- Variables de entorno: `{{ $env.VARIABLE }}`
- Fecha actual: `{{ $now.toISO() }}`

---

## Patrones de Workflow Recomendados

### 1. Trigger → Process → Output (básico)
```
[Trigger] → [Transform/Code] → [Output (HTTP/Email/DB)]
```

### 2. Webhook → Validate → Transform → Store
```
[Webhook] → [IF: validación] → [Set/Code: transform] → [DB/Storage]
                    ↓ error
              [Respond: error 400]
```

### 3. Schedule → Fetch → Enrich → Notify
```
[Cron] → [HTTP Request] → [Code: enrich] → [IF: condición] → [Slack/Email]
```

### 4. Error Handling Pattern
- Siempre conectar el pin de error de nodos críticos a un nodo de notificación.
- Usar `{{ $json.error.message }}` para capturar mensajes de error.

### 5. AI Agent Pattern
```
[Trigger] → [AI Agent] → [Tool: HTTP/DB/Code] → [Respond]
```

---

## Flujo de Trabajo con Claude

Para construir un workflow, descríbeme:
1. **Qué debe hacer el workflow** (objetivo)
2. **Qué lo dispara** (webhook, cron, evento)
3. **Qué servicios externos usa** (APIs, bases de datos, apps)
4. **Qué debe producir** (respuesta, notificación, dato guardado)

Claude entonces:
1. Consulta n8n-mcp para encontrar los nodos más adecuados
2. Valida la configuración de cada nodo
3. Crea o actualiza el workflow en tu instancia n8n
4. Te confirma el resultado y el enlace al workflow

---

## Checklist de Setup

- [x] Crear CLAUDE.md
- [x] Crear `.mcp.json` con credenciales de n8n
- [x] Instalar n8n-skills: copiados a `~/.claude/skills/` (7 skills)
- [ ] Verificar conexión MCP (reiniciar Claude Code para cargar el servidor)

---

## Casos de Uso Principales

Este proyecto está optimizado para:
- **Automatizaciones de datos**: ETL, transformaciones, sincronización entre bases de datos
- **Integraciones de APIs**: Conectar servicios externos, webhooks, REST APIs
- **Notificaciones y alertas**: Slack, email, Telegram, WhatsApp Business
- **IA y LLMs**: Agentes con OpenAI/Claude, procesamiento de lenguaje natural, chatbots
