export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Failed to read file as data URL'))
      }
    }
    reader.onerror = () => reject(reader.error || new Error('Failed to read file as data URL'))
    reader.readAsDataURL(file)
  })
}

let pastedImageSequence = 0

export function filenameForPastedImage(file: File): string {
  const extension = file.type.split('/')[1] || 'png'
  const uniqueSuffix = `${Date.now()}-${++pastedImageSequence}`
  const name = file.name?.trim()
  if (!name) return `clipboard-${uniqueSuffix}.${extension}`

  const dotIndex = name.lastIndexOf('.')
  if (dotIndex > 0 && dotIndex < name.length - 1) {
    return `${name.slice(0, dotIndex)}-${uniqueSuffix}${name.slice(dotIndex)}`
  }
  return `${name}-${uniqueSuffix}.${extension}`
}
