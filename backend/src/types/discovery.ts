export interface DiscoveredInput {
  type: string
  name: string | null
  id: string | null
  placeholder: string | null
  label: string | null
  required: boolean
  disabled: boolean
}

export interface DiscoveredButton {
  text: string
  type: string
  name: string | null
  disabled: boolean
}

export interface DiscoveredLink {
  text: string
  href: string
}

export interface DiscoveredForm {
  action: string
  method: string
  name: string | null
  id: string | null
  controls: number
}

export interface DiscoveryResult {
  title: string
  url: string
  inputs: DiscoveredInput[]
  buttons: DiscoveredButton[]
  links: DiscoveredLink[]
  forms: DiscoveredForm[]
  screenshot: {
    mimeType: "image/png"
    encoding: "base64"
    data: string
  }
}
