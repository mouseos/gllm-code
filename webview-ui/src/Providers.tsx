import { HeroUIProvider } from "@heroui/react"
import { type ReactNode, useEffect } from "react"
import { I18nextProvider } from "react-i18next"
import { CustomPostHogProvider } from "./CustomPostHogProvider"
import { ClineAuthProvider } from "./context/ClineAuthContext"
import { ExtensionStateContextProvider, useExtensionState } from "./context/ExtensionStateContext"
import { PlatformProvider } from "./context/PlatformContext"
import i18n, { LANGUAGE_CODE_MAP } from "./i18n"

const I18nLanguageSync = () => {
	const { preferredLanguage } = useExtensionState()
	useEffect(() => {
		const code = LANGUAGE_CODE_MAP[preferredLanguage ?? "English"] ?? "en"
		if (i18n.language !== code) {
			i18n.changeLanguage(code)
		}
	}, [preferredLanguage])
	return null
}

export function Providers({ children }: { children: ReactNode }) {
	return (
		<PlatformProvider>
			<ExtensionStateContextProvider>
				<I18nextProvider i18n={i18n}>
					<I18nLanguageSync />
					<CustomPostHogProvider>
						<ClineAuthProvider>
							<HeroUIProvider>{children}</HeroUIProvider>
						</ClineAuthProvider>
					</CustomPostHogProvider>
				</I18nextProvider>
			</ExtensionStateContextProvider>
		</PlatformProvider>
	)
}
