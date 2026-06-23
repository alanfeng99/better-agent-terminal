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

function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to decode image'))
    img.src = dataUrl
  })
}

export async function maybeResizeImageDataUrl(
  dataUrl: string,
  threshold = 2000,
  targetMax = 1900,
): Promise<string> {
  if (!dataUrl.startsWith('data:image/')) return dataUrl
  // SVG is vector and cannot be sensibly resized via canvas; leave untouched.
  if (dataUrl.startsWith('data:image/svg')) return dataUrl

  let img: HTMLImageElement
  try {
    img = await loadImageFromDataUrl(dataUrl)
  } catch {
    return dataUrl
  }

  const { naturalWidth: width, naturalHeight: height } = img
  if (!width || !height) return dataUrl
  if (width <= threshold && height <= threshold) return dataUrl

  const scale = targetMax / Math.max(width, height)
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return dataUrl
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight)

  const mime = dataUrl.slice(5, dataUrl.indexOf(';'))
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    return canvas.toDataURL('image/jpeg', 0.92)
  }
  if (mime === 'image/webp') {
    return canvas.toDataURL('image/webp', 0.92)
  }
  return canvas.toDataURL('image/png')
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
