import type { PluginDef } from '@src/path.js';
import React from 'react';
interface PluginItem extends PluginDef {
    installed: boolean;
}
interface PluginHelpProps {
    data: {
        plugins: PluginItem[];
    };
}
export default function PluginHelp({ data }: PluginHelpProps): React.JSX.Element;
export {};
