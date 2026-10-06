import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./Dialog.module.css";

/** Native modal behavior provides keyboard focus containment, Escape and focus return. */
export function Dialog({ label, onClose, children, className = "" }: {
	label: string;
	onClose: () => void;
	children: ReactNode;
	className?: string;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useLayoutEffect(() => {
		const dialog = ref.current!;
		dialog.showModal();
		return () => dialog.close();
	}, []);

	return createPortal(
		<dialog
			ref={ref}
			aria-label={label}
			className={`${styles.dialog} ${className}`}
			onCancel={(event) => {
				if (event.target !== event.currentTarget) return;
				event.preventDefault();
				onClose();
			}}
			onClick={(event) => {
				if (event.target !== event.currentTarget) return;
				const rect = event.currentTarget.getBoundingClientRect();
				if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
			}}
		>
			{children}
		</dialog>,
		document.body,
	);
}
