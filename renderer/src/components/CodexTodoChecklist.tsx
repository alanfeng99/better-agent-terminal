interface TodoChecklistProps {
  input: Record<string, unknown>
}

export function CodexTodoChecklist({ input }: TodoChecklistProps) {
  const rawTodos = input.todos as Array<{ content?: string; text?: string; description?: string; status?: string; completed?: boolean; activeForm?: string }> | undefined
  if (!rawTodos || !Array.isArray(rawTodos)) return null
  const todos = rawTodos
    .map(todo => {
      const content = String(todo.content ?? todo.text ?? todo.description ?? '').trim()
      const status = todo.status || (todo.completed ? 'completed' : 'pending')
      return { content, status }
    })
    .filter(todo => todo.content)
  if (todos.length === 0) return null
  return (
    <div className="claude-todo-checklist">
      {todos.map((todo, i) => (
        <div key={i} className={`claude-todo-item claude-todo-${todo.status}`}>
          <span className="claude-todo-check">
            {todo.status === 'completed' ? '\u2611' : todo.status === 'in_progress' ? '\u25B6' : '\u2610'}
          </span>
          <span className="claude-todo-text">{todo.content}</span>
        </div>
      ))}
    </div>
  )
}
