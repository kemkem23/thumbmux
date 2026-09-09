type $$ComponentProps = {
    /** Source image. Set to null by REMOVE/CLEAR; bind it to follow along. */
    image?: Blob | null;
    /** Draft comment; bind it to keep the text after the panel closes. */
    comment?: string;
    /** Gets the exported PNG plus the trimmed comment. Awaited before success. */
    onSubmit: (draft: {
        image: Blob;
        comment: string;
    }) => void | Promise<void>;
    onClose: () => void;
};
declare const ImageAnnotator: import("svelte").Component<$$ComponentProps, {
    clearAll: () => void;
    removeImage: () => void;
    submit: () => Promise<void>;
}, "image" | "comment">;
type ImageAnnotator = ReturnType<typeof ImageAnnotator>;
export default ImageAnnotator;
