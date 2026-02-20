# PR no mergeable: "La rama tiene conflictos de fusión"

Este error **no es de la app** (cámara/cronómetro), es de GitHub: tu rama y la rama base cambiaron las mismas líneas.

## Solución rápida (desde local)

## Solución automática (recomendada en este repo)

Puedes usar el script incluido para reconstruir tu rama encima de `origin/main` y re-aplicar tus commits:

```bash
git checkout <tu-rama>
scripts/fix_pr_conflicts.sh main
git push --force-with-lease origin <tu-rama>
```

Si durante el `cherry-pick` aparece conflicto en `app.js` o `index.html`, el script lo auto-resuelve conservando tu versión del PR (`--theirs`). Si hay conflictos en otros archivos, se para y te indica cómo continuar manualmente.

1. Trae la base más reciente:

```bash
git fetch origin
```

2. Rebase de tu rama contra `main`:

```bash
git checkout <tu-rama>
git rebase origin/main
```

3. Si hay conflictos, abre los archivos marcados y resuelve los bloques:

```text
<<<<<<< HEAD
(cambios de main)
=======
(cambios de tu rama)
>>>>>>> <commit>
```

4. Marca resuelto y continúa:

```bash
git add app.js index.html
git rebase --continue
```

5. Sube la rama reescrita:

```bash
git push --force-with-lease
```

Después de eso, el PR debería pasar de **"not mergeable"** a **mergeable**.

## Alternativa en GitHub (web)

- En el PR, pulsa **Resolve conflicts**.
- Elige el contenido final en `app.js` / `index.html`.
- Marca **Resolved** y luego **Commit merge**.

## Nota para este repo

Los conflictos suelen caer en `app.js` e `index.html` porque concentran la mayoría de cambios de UI y lógica.
