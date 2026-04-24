import type { CSSProperties, HTMLAttributes } from "react"
import type { Environment } from "../../../src/shared/config-types"
import { getEnvironmentColor } from "../utils/environmentColors"
import gllmLogo from "./gllm-logo.png"

/**
 * Renders the GLLM Code brand mark. Uses `mask-image` so the silhouette
 * inherits the current VS Code icon color (and environment tint when the
 * caller is on staging/local), instead of forcing the raw white PNG onto
 * light themes.
 */
const ClineLogoVariable = (props: HTMLAttributes<HTMLSpanElement> & { environment?: Environment }) => {
	const { environment, style, className, ...spanProps } = props
	const color = environment ? getEnvironmentColor(environment) : "var(--vscode-icon-foreground)"
	const maskStyle: CSSProperties = {
		display: "inline-block",
		backgroundColor: color,
		WebkitMaskImage: `url(${gllmLogo})`,
		maskImage: `url(${gllmLogo})`,
		WebkitMaskRepeat: "no-repeat",
		maskRepeat: "no-repeat",
		WebkitMaskPosition: "center",
		maskPosition: "center",
		WebkitMaskSize: "contain",
		maskSize: "contain",
		...style,
	}
	return <span aria-hidden className={className} style={maskStyle} {...spanProps} />
}
export default ClineLogoVariable
